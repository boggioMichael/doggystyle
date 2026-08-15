import type { MediaAssetDto, SocialProviderId } from '@doggystyle/shared';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { clusterSignatures } from '../../ai/heuristic/media.js';
import { getAiProvider } from '../../ai/index.js';
import { redactText } from '../../ai/redact.js';
import type { MediaFeatures } from '../../ai/types.js';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { dogProfiles, dogs, mediaAssets } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { sha256Hex } from '../../lib/crypto.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { mediaStore, type SavedMediaFile } from './store.js';

/**
 * Media ingestion pipeline.
 *
 * One choke point (`ingestImageBuffer`) for every image that enters the system
 * — direct uploads and social imports alike — so content sniffing, size limits,
 * dedupe, the EXIF/GPS scrub (in the store) and local-only analysis cannot be
 * bypassed by any individual entry path.
 */

export type MediaAssetRow = typeof mediaAssets.$inferSelect;

/** Below this dog-likelihood the photo is stored as "rejected" (owner can override). */
const MIN_DOG_SCORE = 0.12;

/** Signature distance threshold for "same dog" clustering. */
const CLUSTER_THRESHOLD = 0.34;

const CAPTION_MAX = 500;

/** Placeholder perceptual hash: first 16 hex chars of the sha256 for now. */
const DHASH_HEX_LEN = 16;

/* ─────────────────────────────────────────────────────────────────────────────
 * Content sniffing
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Magic-byte detection. The declared mime type is untrusted client input — the
 * first bytes of the buffer decide what this actually is.
 * jpeg ff d8 ff · png 89 50 4e 47 · webp "RIFF"…"WEBP" · gif "GIF8"
 */
function sniffImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ingestImageBuffer
 * ───────────────────────────────────────────────────────────────────────────*/

export interface IngestResult {
  assetId: string | null;
  duplicate: boolean;
  /** Set when the buffer was not stored, or stored but not usable as a dog photo. */
  rejected?: string;
}

export async function ingestImageBuffer(args: {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  caption?: string | null;
  provider?: SocialProviderId | 'manual';
  externalId?: string | null;
  importId?: string | null;
  takenAt?: Date | null;
}): Promise<IngestResult> {
  const { userId, buffer } = args;
  const provider = args.provider ?? 'upload';

  // Content decides, not the declared mime type (untrusted client input).
  const detected = sniffImageType(buffer);
  if (!detected) return { assetId: null, duplicate: false, rejected: 'unsupported_type' };

  // Multipart limits already enforce this for uploads; this guards import paths
  // that hand us buffers directly (social providers, archives).
  if (buffer.length > env.maxUploadBytes) return { assetId: null, duplicate: false, rejected: 'too_large' };

  /* ── Per-user dedupe on the ORIGINAL bytes ──────────────────────────────── */
  const sha256 = sha256Hex(buffer);
  const [existing] = await db
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.sha256, sha256)))
    .limit(1);
  if (existing) return { assetId: existing.id, duplicate: true };

  /* ── Analyse locally (pixels never leave the machine) + scrubbed store ──── */
  let features: MediaFeatures;
  let saved: SavedMediaFile;
  try {
    features = await getAiProvider().analyseImage(buffer);
    saved = await mediaStore.save({ userId, buffer, mimeType: detected });
  } catch (err) {
    // Passed the magic-byte check but sharp could not decode it — corrupt file.
    logger.warn({ err, userId }, 'media ingest: undecodable image buffer');
    return { assetId: null, duplicate: false, rejected: 'unreadable_image' };
  }

  // Captions can come from third-party feeds — scrub PII before storing.
  const caption = args.caption?.trim() ? redactText(args.caption.trim()).slice(0, CAPTION_MAX) : null;

  // Visual statistics alone are a weak signal; the caption is often decisive
  // ("Morning zoomies with Rex"). Combining them is what the spec asks for —
  // the result is still only a suggestion the owner confirms.
  const dogScore = combineDogEvidence(features.dogScore, caption);
  const noDog = dogScore < MIN_DOG_SCORE;

  const [row] = await db
    .insert(mediaAssets)
    .values({
      userId,
      importId: args.importId ?? null,
      provider,
      externalId: args.externalId ?? null,
      storageKey: saved.storageKey,
      thumbKey: saved.thumbKey,
      // What we serve: every rendition is a re-encoded WebP regardless of input.
      mimeType: 'image/webp',
      bytes: saved.bytes,
      width: saved.width,
      height: saved.height,
      sha256,
      dhash: sha256.slice(0, DHASH_HEX_LEN),
      caption,
      takenAt: args.takenAt ?? null,
      dogScore,
      qualityScore: features.qualityScore,
      signature: features.signature,
      // Low-score photos are stored anyway so the owner can override the
      // classifier later — they just never surface as profile photos.
      status: noDog ? 'rejected' : 'processed',
      rejectedReason: noDog ? 'no_dog_detected' : null,
    })
    .onConflictDoNothing({ target: [mediaAssets.userId, mediaAssets.sha256] })
    .returning({ id: mediaAssets.id });

  if (!row) {
    // A concurrent ingest of the same bytes won the unique-index race — keep
    // that row and drop the files we just wrote.
    await mediaStore.delete(saved.storageKey);
    await mediaStore.delete(saved.thumbKey);
    const [winner] = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.sha256, sha256)))
      .limit(1);
    return { assetId: winner?.id ?? null, duplicate: true };
  }

  if (noDog) return { assetId: row.id, duplicate: false, rejected: 'no_dog_detected' };
  return { assetId: row.id, duplicate: false };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * processPendingAssetsForUser — clustering & default profile photo
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Re-cluster all of a user's live photos by visual signature and, when the
 * owner has not explicitly chosen a profile photo, flag the best photo of the
 * largest cluster as the default. Idempotent — safe to call after every batch.
 */
export async function processPendingAssetsForUser(userId: string): Promise<void> {
  const rows = await db
    .select({
      id: mediaAssets.id,
      clusterId: mediaAssets.clusterId,
      qualityScore: mediaAssets.qualityScore,
      status: mediaAssets.status,
      isProfilePhoto: mediaAssets.isProfilePhoto,
      signature: mediaAssets.signature,
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.userId, userId), isNull(mediaAssets.deletedAt), sql`${mediaAssets.signature} is not null`))
    // Deterministic input order → stable cluster ids for an unchanged photo set.
    .orderBy(asc(mediaAssets.createdAt));
  if (rows.length === 0) return;

  const assignment = clusterSignatures(
    rows.map((r) => ({ id: r.id, signature: r.signature ?? [] })),
    CLUSTER_THRESHOLD,
  );

  /* ── Persist cluster ids (only the ones that changed) ───────────────────── */
  const now = new Date();
  const changedByCluster = new Map<string, string[]>();
  for (const row of rows) {
    const clusterId = assignment.get(row.id);
    if (!clusterId || clusterId === row.clusterId) continue;
    const ids = changedByCluster.get(clusterId) ?? [];
    ids.push(row.id);
    changedByCluster.set(clusterId, ids);
  }
  for (const [clusterId, ids] of changedByCluster) {
    await db.update(mediaAssets).set({ clusterId, updatedAt: now }).where(inArray(mediaAssets.id, ids));
  }

  /* ── Default profile photo for the largest cluster ──────────────────────── */
  // Owner intent wins: if any live dog profile points at a still-live asset,
  // the choice was made deliberately (by the owner or profile generation) and
  // re-clustering must never silently override it.
  const [chosen] = await db
    .select({ id: dogProfiles.profilePhotoId })
    .from(dogProfiles)
    .innerJoin(dogs, eq(dogs.id, dogProfiles.dogId))
    .innerJoin(mediaAssets, eq(mediaAssets.id, dogProfiles.profilePhotoId))
    .where(and(eq(dogs.ownerId, userId), isNull(dogs.deletedAt), isNull(mediaAssets.deletedAt)))
    .limit(1);
  if (chosen) return;

  const counts = new Map<string, number>();
  for (const clusterId of assignment.values()) counts.set(clusterId, (counts.get(clusterId) ?? 0) + 1);
  let largest: string | null = null;
  for (const [clusterId, count] of counts) {
    if (largest === null || count > (counts.get(largest) ?? 0)) largest = clusterId;
  }
  if (!largest) return;

  // Only processed photos qualify — a "rejected" (no dog detected) photo must
  // never become anyone's face.
  const members = rows.filter((r) => assignment.get(r.id) === largest && r.status === 'processed');
  // Sorted in JS: SQL DESC would put NULL quality scores first in Postgres.
  members.sort((a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1));
  const best = members[0];
  if (!best) return;

  await db.transaction(async (tx) => {
    // Exactly one flagged photo per user in the auto-selected state.
    await tx
      .update(mediaAssets)
      .set({ isProfilePhoto: false, updatedAt: now })
      .where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.isProfilePhoto, true), ne(mediaAssets.id, best.id)));
    if (!best.isProfilePhoto) {
      await tx.update(mediaAssets).set({ isProfilePhoto: true, updatedAt: now }).where(eq(mediaAssets.id, best.id));
    }
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DTO
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Wire shape for a media asset. Deliberately omits storageKey, sha256, dhash
 * and import internals — this DTO is embedded in peer-visible profiles, so it
 * carries only opaque route URLs, never filesystem or hash details.
 */
export function mediaAssetToDto(row: MediaAssetRow): MediaAssetDto {
  return {
    id: row.id,
    url: `/api/media/${row.id}/file`,
    thumbUrl: `/api/media/${row.id}/thumb`,
    width: row.width,
    height: row.height,
    isProfilePhoto: row.isProfilePhoto,
    dogScore: row.dogScore,
    qualityScore: row.qualityScore,
    caption: row.caption,
    source: row.provider as MediaAssetDto['source'],
    clusterId: row.clusterId,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Caption evidence
 * ───────────────────────────────────────────────────────────────────────────*/

/** Words in a caption that make it much more likely the photo shows a dog. */
const DOG_CAPTION_TERMS = [
  'dog', 'puppy', 'pup', 'doggo', 'good boy', 'good girl', 'zoomies', 'walkies', 'fetch',
  'leash', 'lead', 'paw', 'tail wag', 'wagging', 'kennel', 'vet', 'rescue', 'adopted',
  'off-leash', 'dog park', 'treat', 'fur baby', 'furbaby', 'woof', 'bark', 'snout',
  'retriever', 'collie', 'terrier', 'spaniel', 'shepherd', 'labrador', 'poodle', 'husky',
  'beagle', 'dachshund', 'corgi', 'bulldog', 'chihuahua', 'samoyed', 'chow',
];

/** Caption words suggesting the photo is clearly not a dog portrait. */
const NON_DOG_CAPTION_TERMS = ['skyline', 'sunset over', 'cityscape', 'dinner', 'brunch plate', 'selfie', 'landscape'];

/**
 * Blend the local visual estimate with caption evidence.
 *
 * Kept as a small pure function so it is unit-testable and so the weighting is
 * visible rather than buried in the ingest path.
 */
export function combineDogEvidence(visualScore: number, caption: string | null): number {
  if (!caption) return round3(visualScore);
  const text = caption.toLowerCase();

  const positives = DOG_CAPTION_TERMS.filter((t) => text.includes(t)).length;
  const negatives = NON_DOG_CAPTION_TERMS.filter((t) => text.includes(t)).length;

  let score = visualScore;
  if (positives > 0) {
    // Strong but bounded: two or more dog words is near-conclusive.
    const boost = Math.min(0.45, 0.28 + 0.12 * (positives - 1));
    score = visualScore + boost * (1 - visualScore);
  }
  if (negatives > 0 && positives === 0) {
    score = visualScore * 0.45;
  }
  return round3(Math.min(1, Math.max(0, score)));
}

const round3 = (v: number): number => Number(v.toFixed(3));

/* ─────────────────────────────────────────────────────────────────────────────
 * Deletion
 *
 * Lives here (not in the route) because two callers need the identical
 * authorisation and profile-photo-promotion behaviour: DELETE /media/:id and
 * the conversational agent's `delete_media` action.
 * ───────────────────────────────────────────────────────────────────────────*/

export async function deleteMediaAsset(input: {
  actorUserId: string;
  mediaId: string;
  requestId?: string | null;
}): Promise<void> {
  const { actorUserId, mediaId, requestId = null } = input;

  // Owner filter in the query: a foreign id and a missing id are the same 404.
  const [asset] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.id, mediaId), eq(mediaAssets.userId, actorUserId), isNull(mediaAssets.deletedAt)))
    .limit(1);
  if (!asset) throw notFound('Photo not found.');

  const now = new Date();

  const pointingProfiles = await db
    .select({ dogId: dogProfiles.dogId })
    .from(dogProfiles)
    .where(eq(dogProfiles.profilePhotoId, mediaId));
  const wasProfilePhoto = asset.isProfilePhoto || pointingProfiles.length > 0;

  // Next-best photo from the same cluster to promote in its place.
  let promoted: { id: string } | null = null;
  if (wasProfilePhoto && asset.clusterId) {
    const candidates = await db
      .select({ id: mediaAssets.id, qualityScore: mediaAssets.qualityScore })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.userId, actorUserId),
          eq(mediaAssets.clusterId, asset.clusterId),
          eq(mediaAssets.status, 'processed'),
          isNull(mediaAssets.deletedAt),
          ne(mediaAssets.id, asset.id),
        ),
      );
    // Sorted in JS: SQL DESC would put NULL quality scores first in Postgres.
    candidates.sort((a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1));
    promoted = candidates[0] ?? null;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(mediaAssets)
      .set({ deletedAt: now, isProfilePhoto: false, updatedAt: now })
      .where(eq(mediaAssets.id, mediaId));
    if (pointingProfiles.length > 0) {
      await tx
        .update(dogProfiles)
        .set({ profilePhotoId: promoted?.id ?? null, updatedAt: now })
        .where(eq(dogProfiles.profilePhotoId, mediaId));
    }
    if (promoted) {
      await tx.update(mediaAssets).set({ isProfilePhoto: true, updatedAt: now }).where(eq(mediaAssets.id, promoted.id));
    }
  });

  // Files go after the commit — a failed unlink must not undo the soft delete.
  await mediaStore.delete(asset.storageKey);
  await mediaStore.delete(asset.thumbKey);

  await recordAudit({
    actorUserId,
    action: 'media.delete',
    targetType: 'media',
    targetId: mediaId,
    summary: wasProfilePhoto ? 'photo deleted (was profile photo)' : 'photo deleted',
    after: promoted ? { promotedAssetId: promoted.id } : null,
    requestId,
  });
}
