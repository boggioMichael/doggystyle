import { createReadStream, existsSync } from 'node:fs';
import type { MediaImportSummaryDto } from '@doggystyle/shared';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { blocks, connections, dogProfiles, dogs, mediaAssets, mediaImports } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound, tooManyRequests } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { assertDogOwner } from '../dogs/service.js';
import {
  deleteMediaAsset,
  ingestImageBuffer,
  mediaAssetToDto,
  processPendingAssetsForUser,
  type IngestResult,
  type MediaAssetRow,
} from './service.js';
import { mediaStore } from './store.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Schemas & helpers
 * ───────────────────────────────────────────────────────────────────────────*/

const idParams = z.object({ id: z.string().uuid() });

const dogIdField = z.string().uuid();

/** Hard ceiling on assets created per user per day, on top of the rate limiter. */
const DAILY_UPLOAD_CAP = 300;

const IMAGE_CACHE_CONTROL = 'private, max-age=3600';

function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
  const result = schema.safeParse(params ?? {});
  if (!result.success) throw badRequest('Invalid request parameters.', result.error.flatten());
  return result.data;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Authorisation: who may see a photo's bytes
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Returns false rather than throwing so the caller can respond with notFound —
 * a viewer must never learn whether a denied id exists (no enumeration oracle).
 */
async function canViewAsset(asset: MediaAssetRow, viewerUserId: string): Promise<boolean> {
  // Owner always sees their own photos (including rejected ones).
  if (asset.userId === viewerUserId) return true;

  // A block in either direction hides everything between the two owners —
  // checked before any grant, so it also trumps a still-active connection.
  const [blocked] = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerUserId, viewerUserId), eq(blocks.blockedUserId, asset.userId)),
        and(eq(blocks.blockerUserId, asset.userId), eq(blocks.blockedUserId, viewerUserId)),
      ),
    )
    .limit(1);
  if (blocked) return false;

  // Public profile photo of a live, active, publicly visible dog.
  if (asset.isProfilePhoto) {
    const owning = asset.dogId
      ? await db
          .select({ status: dogs.status, visibility: dogProfiles.visibility })
          .from(dogs)
          .innerJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
          .where(and(eq(dogs.id, asset.dogId), isNull(dogs.deletedAt)))
          .limit(1)
      : // Auto-flagged photos may not be assigned to a dog yet — resolve the
        // owning dog through the profile that points at this asset.
        await db
          .select({ status: dogs.status, visibility: dogProfiles.visibility })
          .from(dogProfiles)
          .innerJoin(dogs, eq(dogs.id, dogProfiles.dogId))
          .where(and(eq(dogProfiles.profilePhotoId, asset.id), isNull(dogs.deletedAt)))
          .limit(1);
    const dog = owning[0];
    if (dog && dog.status === 'active' && dog.visibility === 'public') return true;
  }

  // An ACTIVE connection between the two owners grants access to the peer's photos.
  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.status, 'active'),
        or(
          and(eq(connections.userAId, viewerUserId), eq(connections.userBId, asset.userId)),
          and(eq(connections.userAId, asset.userId), eq(connections.userBId, viewerUserId)),
        ),
      ),
    )
    .limit(1);
  return Boolean(connection);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Streaming
 * ───────────────────────────────────────────────────────────────────────────*/

async function sendAssetFile(req: FastifyRequest, reply: FastifyReply, variant: 'file' | 'thumb'): Promise<FastifyReply> {
  const actor = req.requireUser();
  const { id } = parseParams(idParams, req.params);

  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, id), isNull(mediaAssets.deletedAt)))
    .limit(1);
  // notFound (never forbidden) for missing AND unauthorised — same response.
  if (!asset || !(await canViewAsset(asset, actor.userId))) throw notFound('Photo not found.');

  const key = variant === 'thumb' ? (asset.thumbKey ?? asset.storageKey) : asset.storageKey;
  const absolute = mediaStore.absolutePath(key); // traversal-guarded
  if (!existsSync(absolute)) throw notFound('Photo not found.');

  reply.header('content-type', 'image/webp');
  reply.header('cache-control', IMAGE_CACHE_CONTROL);
  return reply.send(createReadStream(absolute));
}

/**
 * The global security onSend hook stamps `no-store` on every /api/* response.
 * Route-level onSend hooks run after instance-level ones, so this restores a
 * browser-cacheable (but still `private`) policy for immutable image bytes.
 */
const imageCacheHook = async (_req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
  reply.header('cache-control', IMAGE_CACHE_CONTROL);
  return payload;
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Cluster summary (for MediaImportSummaryDto)
 * ───────────────────────────────────────────────────────────────────────────*/

async function clusterSummaries(userId: string): Promise<MediaImportSummaryDto['clusters']> {
  const rows = await db
    .select({
      id: mediaAssets.id,
      clusterId: mediaAssets.clusterId,
      qualityScore: mediaAssets.qualityScore,
      isProfilePhoto: mediaAssets.isProfilePhoto,
    })
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.userId, userId),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.status, 'processed'),
        sql`${mediaAssets.clusterId} is not null`,
      ),
    );

  const groups = new Map<string, { count: number; coverId: string; coverQuality: number; coverIsProfile: boolean }>();
  for (const row of rows) {
    if (!row.clusterId) continue;
    const quality = row.qualityScore ?? -1;
    const group = groups.get(row.clusterId);
    if (!group) {
      groups.set(row.clusterId, { count: 1, coverId: row.id, coverQuality: quality, coverIsProfile: row.isProfilePhoto });
      continue;
    }
    group.count += 1;
    // Cover: the flagged profile photo wins, then the highest quality score.
    const better =
      (row.isProfilePhoto && !group.coverIsProfile) ||
      (row.isProfilePhoto === group.coverIsProfile && quality > group.coverQuality);
    if (better) {
      group.coverId = row.id;
      group.coverQuality = quality;
      group.coverIsProfile = row.isProfilePhoto;
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([clusterId, g]) => ({
      clusterId,
      count: g.count,
      coverUrl: `/api/media/${g.coverId}/thumb`,
      suggestedName: null,
    }));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Routes
 * ───────────────────────────────────────────────────────────────────────────*/

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Direct photo upload: multipart with one or more "files" parts and an
   * optional "dogId" text field. Every buffer goes through the single ingest
   * choke point (sniffing, size limit, dedupe, EXIF scrub, local analysis).
   */
  app.post('/media/upload', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.upload, actor.userId);
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data with a "files" field.');

    // Daily cap counts every asset created today, deleted or not, so
    // delete-and-reupload cannot bypass it.
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const [countRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.userId, actor.userId), gt(mediaAssets.createdAt, dayStart)));
    if ((countRow?.n ?? 0) >= DAILY_UPLOAD_CAP) {
      throw tooManyRequests('Daily photo limit reached. Try again tomorrow.');
    }

    // Uploads get a real import row so provenance and summary queries treat
    // them exactly like any other media source.
    const [importRow] = await db
      .insert(mediaImports)
      .values({ userId: actor.userId, provider: 'upload', status: 'running' })
      .returning({ id: mediaImports.id });
    const importId = importRow!.id;

    let dogId: string | null = null;
    let filesSeen = 0;
    const results: IngestResult[] = [];

    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'files') {
            await part.toBuffer(); // drain unexpected file fields so the stream completes
            continue;
          }
          filesSeen += 1;
          const buffer = await part.toBuffer();
          // Caption deliberately null: filenames are noise, not descriptions.
          results.push(
            await ingestImageBuffer({
              userId: actor.userId,
              buffer,
              mimeType: part.mimetype,
              provider: 'upload',
              importId,
            }),
          );
        } else if (part.fieldname === 'dogId') {
          const parsed = dogIdField.safeParse(part.value);
          if (!parsed.success) throw badRequest('Invalid dogId.');
          dogId = parsed.data;
        }
      }

      if (filesSeen === 0) throw badRequest('No files received. Send images in the "files" field.');

      const assetIds = results.map((r) => r.assetId).filter((id): id is string => id !== null);
      if (dogId) {
        // Ownership check throws notFound for a foreign dog — no id enumeration.
        await assertDogOwner(dogId, actor.userId);
        if (assetIds.length > 0) {
          await db
            .update(mediaAssets)
            .set({ dogId, updatedAt: new Date() })
            .where(and(inArray(mediaAssets.id, assetIds), eq(mediaAssets.userId, actor.userId)));
        }
      }

      // Re-cluster + pick a default profile photo if the owner has none.
      await processPendingAssetsForUser(actor.userId);
    } catch (err) {
      await db
        .update(mediaImports)
        .set({ status: 'failed', itemsFetched: filesSeen, message: 'Upload failed.', updatedAt: new Date() })
        .where(eq(mediaImports.id, importId));
      throw err;
    }

    const stored = results.filter((r) => r.assetId !== null && !r.duplicate).length;
    const duplicates = results.filter((r) => r.duplicate).length;
    const dogPhotos = results.filter((r) => r.assetId !== null && !r.duplicate && !r.rejected).length;

    await db
      .update(mediaImports)
      .set({ status: 'complete', itemsFetched: filesSeen, itemsStored: stored, duplicates, updatedAt: new Date() })
      .where(eq(mediaImports.id, importId));

    await recordAudit({
      actorUserId: actor.userId,
      action: 'media.upload',
      targetType: 'media_import',
      targetId: importId,
      summary: `uploaded ${filesSeen} file(s): ${stored} stored, ${duplicates} duplicate(s)`,
      after: { filesSeen, stored, duplicates, dogPhotos, ...(dogId ? { dogId } : {}) },
      requestId: req.requestId,
    });

    return {
      importId,
      provider: 'upload',
      itemsFetched: filesSeen,
      itemsStored: stored,
      duplicates,
      dogPhotos,
      clusters: await clusterSummaries(actor.userId),
      status: 'complete',
      message: null,
    } satisfies MediaImportSummaryDto;
  });

  /** All of the actor's live photos, newest first — including rejected ones,
   *  which the UI explains (and lets the owner override). */
  app.get('/media/mine', async (req) => {
    const actor = req.requireUser();
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.userId, actor.userId), isNull(mediaAssets.deletedAt)))
      .orderBy(desc(mediaAssets.createdAt));
    return rows.map((row) => mediaAssetToDto(row));
  });

  /* ── Image bytes — always authorised, never served as static files ──────── */
  app.get('/media/:id/file', { onSend: imageCacheHook }, async (req, reply) => sendAssetFile(req, reply, 'file'));
  app.get('/media/:id/thumb', { onSend: imageCacheHook }, async (req, reply) => sendAssetFile(req, reply, 'thumb'));

  /** Owner-only soft delete. Files are unlinked; the row keeps its audit trail. */
  app.delete('/media/:id', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = parseParams(idParams, req.params);

    // The whole deletion (ownership check included) lives in the service so the
    // chat agent's delete_media action goes through the exact same gate.
    await deleteMediaAsset({ actorUserId: actor.userId, mediaId: id, requestId: req.requestId });

    reply.status(204).send();
  });
}
