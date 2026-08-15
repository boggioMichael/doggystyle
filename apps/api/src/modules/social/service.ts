import type { MediaImportSummaryDto, SocialProviderDescriptorDto, SocialProviderId } from '@doggystyle/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { consentEvents, mediaAssets, mediaImports, socialAccounts } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { enqueueJob } from '../../jobs/queue.js';
import { ingestImageBuffer, processPendingAssetsForUser } from '../media/service.js';
import { parseArchive, sniffImageMime } from './providers/archiveProvider.js';
import { demoIdentity } from './providers/demoProvider.js';
import { allProviders, getProvider } from './providers/index.js';
import type { SocialAccountRow } from './providers/types.js';

/**
 * Social integration service: connect/disconnect flows, import orchestration,
 * and the descriptors the UI renders.
 *
 * Privacy invariants owned here:
 *  - Token material is stored only as `encryptSecret` ciphertext and is never
 *    serialised into any DTO, log line or error message.
 *  - Every import is preceded by an explicit `consent_events` grant.
 *  - Disconnecting revokes tokens (best effort) but imported media STAYS —
 *    the photos are the user's own content in their own library now; they can
 *    delete assets individually via the media module.
 */

/** Hard ceiling on items per import run — keeps a hostile feed bounded. */
const MAX_ITEMS_PER_IMPORT = 400;

/** Assets at/above this dog-score count as "looks like your dog" in messages. */
const DOG_SCORE_THRESHOLD = 0.5;

/** OAuth state is valid this long between authorize and callback. */
const OAUTH_STATE_TTL_MS = 15 * 60_000;

/* ─────────────────────────────────────────────────────────────────────────────
 * Descriptors
 * ───────────────────────────────────────────────────────────────────────────*/

export async function getProviderDescriptors(userId: string): Promise<SocialProviderDescriptorDto[]> {
  // Latest live (non-revoked) account per provider for this user.
  const accounts = await db
    .select()
    .from(socialAccounts)
    .where(and(eq(socialAccounts.userId, userId), isNull(socialAccounts.revokedAt)))
    .orderBy(desc(socialAccounts.createdAt));

  const byProvider = new Map<string, SocialAccountRow>();
  for (const acct of accounts) {
    if (!byProvider.has(acct.provider)) byProvider.set(acct.provider, acct);
  }

  return allProviders().map((provider) => {
    const d = provider.descriptor();
    const acct = byProvider.get(provider.id);
    return {
      id: provider.id,
      label: d.label,
      description: d.description,
      available: d.available,
      unavailableReason: d.unavailableReason,
      kind: d.kind,
      connected: Boolean(acct),
      // Handle or display name only — never external ids or token material.
      accountLabel: acct ? (acct.handle ?? acct.displayName) : null,
    };
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * OAuth state (anti-CSRF for the callback leg)
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Self-contained encrypted state: no server-side storage needed, and the
 * callback can verify the flow was started by this same signed-in user.
 */
function buildOAuthState(userId: string, provider: SocialProviderId): string {
  return encryptSecret(JSON.stringify({ u: userId, p: provider, t: Date.now() }));
}

function verifyOAuthState(state: string, userId: string, provider: SocialProviderId): boolean {
  const plaintext = decryptSecret(state);
  if (!plaintext) return false;
  try {
    const parsed = JSON.parse(plaintext) as { u?: unknown; p?: unknown; t?: unknown };
    return (
      parsed.u === userId &&
      parsed.p === provider &&
      typeof parsed.t === 'number' &&
      Date.now() - parsed.t < OAUTH_STATE_TTL_MS
    );
  } catch {
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Connect / disconnect
 * ───────────────────────────────────────────────────────────────────────────*/

export async function connectProvider(input: {
  actorUserId: string;
  provider: SocialProviderId;
  requestId?: string;
}): Promise<{ importId?: string; redirectUrl?: string }> {
  const provider = getProvider(input.provider);
  const descriptor = provider.descriptor();
  if (!descriptor.available) {
    // The reason is written for end users (docs/INTEGRATIONS.md wording).
    throw badRequest(descriptor.unavailableReason ?? 'This source is not available right now.');
  }

  switch (input.provider) {
    case 'demo': {
      const importId = await connectDemo(input.actorUserId, input.requestId ?? null);
      return { importId };
    }
    case 'upload':
      // Nothing to connect — the client goes straight to the upload UI.
      return {};
    case 'archive':
      // Nothing to connect — the client POSTs the ZIP to /social/archive/upload.
      return {};
    case 'instagram':
    case 'google_photos': {
      const state = buildOAuthState(input.actorUserId, input.provider);
      const result = await provider.authorize({ userId: input.actorUserId, state });
      if (!result.redirectUrl) throw badRequest('This source did not produce a sign-in link.');
      return { redirectUrl: result.redirectUrl };
    }
  }
}

/** Demo connect: simulate a linked account and queue the synthetic import. */
async function connectDemo(userId: string, requestId: string | null): Promise<string> {
  const identity = demoIdentity(userId);
  const externalId = `demo-${userId}`;
  const handle = `@${identity.name.toLowerCase()}`;

  const [account] = await db
    .insert(socialAccounts)
    .values({
      userId,
      provider: 'demo',
      externalId,
      handle,
      displayName: identity.name,
      scopes: ['demo_media'],
    })
    .onConflictDoUpdate({
      target: [socialAccounts.userId, socialAccounts.provider, socialAccounts.externalId],
      // Reconnecting resurrects a previously revoked demo account.
      set: { handle, displayName: identity.name, revokedAt: null, lastSyncedAt: null },
    })
    .returning({ id: socialAccounts.id });

  const [imp] = await db
    .insert(mediaImports)
    .values({ userId, socialAccountId: account!.id, provider: 'demo', status: 'queued' })
    .returning({ id: mediaImports.id });
  const importId = imp!.id;

  // Explicit, auditable consent record for the import.
  await db.insert(consentEvents).values({
    userId,
    kind: 'social_import',
    granted: true,
    detail: { provider: 'demo' },
  });

  await enqueueJob('social.import', { importId }, { dedupeKey: `social.import:${importId}` });

  await recordAudit({
    actorUserId: userId,
    action: 'social.connect',
    targetType: 'social_account',
    targetId: account!.id,
    summary: 'connected demo source',
    requestId,
  });

  return importId;
}

/**
 * OAuth callback completion: verify state, exchange the code, persist the
 * linked account (tokens already encrypted by the adapter) and queue the
 * first import.
 */
export async function completeOAuthCallback(input: {
  actorUserId: string;
  provider: SocialProviderId;
  code: string;
  state: string;
  requestId?: string;
}): Promise<{ importId: string }> {
  // The state ties the callback to the user who started the flow — without it
  // an attacker could link their own account onto a victim's session.
  if (!verifyOAuthState(input.state, input.actorUserId, input.provider)) {
    throw badRequest('This connection attempt has expired or is invalid. Please start again.');
  }

  const provider = getProvider(input.provider);
  const linked = await provider.handleCallback({ userId: input.actorUserId, code: input.code });

  const [account] = await db
    .insert(socialAccounts)
    .values({
      userId: input.actorUserId,
      provider: input.provider,
      externalId: linked.externalId,
      handle: linked.handle,
      displayName: linked.displayName,
      accessTokenEnc: linked.accessTokenEnc,
      refreshTokenEnc: linked.refreshTokenEnc,
      scopes: linked.scopes,
      expiresAt: linked.expiresAt,
    })
    .onConflictDoUpdate({
      target: [socialAccounts.userId, socialAccounts.provider, socialAccounts.externalId],
      set: {
        handle: linked.handle,
        displayName: linked.displayName,
        accessTokenEnc: linked.accessTokenEnc,
        refreshTokenEnc: linked.refreshTokenEnc,
        scopes: linked.scopes,
        expiresAt: linked.expiresAt,
        revokedAt: null,
      },
    })
    .returning({ id: socialAccounts.id });

  await db.insert(consentEvents).values({
    userId: input.actorUserId,
    kind: 'social_import',
    granted: true,
    detail: { provider: input.provider },
  });

  const [imp] = await db
    .insert(mediaImports)
    .values({ userId: input.actorUserId, socialAccountId: account!.id, provider: input.provider, status: 'queued' })
    .returning({ id: mediaImports.id });
  const importId = imp!.id;

  await enqueueJob('social.import', { importId }, { dedupeKey: `social.import:${importId}` });

  await recordAudit({
    actorUserId: input.actorUserId,
    action: 'social.connect',
    targetType: 'social_account',
    targetId: account!.id,
    summary: `connected ${input.provider} account`,
    requestId: input.requestId ?? null,
  });

  return { importId };
}

export async function disconnectProvider(input: {
  actorUserId: string;
  provider: SocialProviderId;
  requestId?: string;
}): Promise<void> {
  const rows = await db
    .select()
    .from(socialAccounts)
    .where(
      and(
        eq(socialAccounts.userId, input.actorUserId),
        eq(socialAccounts.provider, input.provider),
        isNull(socialAccounts.revokedAt),
      ),
    );
  // notFound (not forbidden) — a disconnect for a provider that is not
  // connected reveals nothing.
  if (rows.length === 0) throw notFound('No connected account for that source.');

  await db
    .update(socialAccounts)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(socialAccounts.userId, input.actorUserId),
        eq(socialAccounts.provider, input.provider),
        isNull(socialAccounts.revokedAt),
      ),
    );

  // Remote revocation is best effort — local revocation above is what stops
  // us using the tokens, and a platform outage must not block a disconnect.
  const provider = getProvider(input.provider);
  for (const acct of rows) {
    try {
      await provider.revoke(acct);
    } catch (err) {
      logger.warn({ err, provider: input.provider }, 'provider token revoke failed (best effort)');
    }
  }

  await db.insert(consentEvents).values({
    userId: input.actorUserId,
    kind: 'social_import',
    granted: false,
    detail: { provider: input.provider },
  });

  // Deliberate: imported media STAYS after disconnect. The photos are now part
  // of the user's own library; deleting them is a separate, per-asset choice
  // in the media module — never a silent side effect of a disconnect.
  await recordAudit({
    actorUserId: input.actorUserId,
    action: 'social.disconnect',
    targetType: 'social_account',
    targetId: rows[0]!.id,
    summary: `disconnected ${input.provider} account`,
    requestId: input.requestId ?? null,
  });
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Import summary
 * ───────────────────────────────────────────────────────────────────────────*/

export async function getImportSummary(input: {
  actorUserId: string;
  importId: string;
}): Promise<MediaImportSummaryDto> {
  // Owner-checked in the query itself: a foreign import id yields 404.
  const [imp] = await db
    .select()
    .from(mediaImports)
    .where(and(eq(mediaImports.id, input.importId), eq(mediaImports.userId, input.actorUserId)))
    .limit(1);
  if (!imp) throw notFound();

  const assets = await db
    .select({
      id: mediaAssets.id,
      clusterId: mediaAssets.clusterId,
      dogScore: mediaAssets.dogScore,
      qualityScore: mediaAssets.qualityScore,
      status: mediaAssets.status,
    })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.importId, imp.id), isNull(mediaAssets.deletedAt)));

  // Cluster aggregation: count per cluster + the best-scoring asset as cover.
  const clusters = new Map<string, { count: number; coverId: string; coverScore: number }>();
  let dogPhotos = 0;
  for (const asset of assets) {
    if ((asset.dogScore ?? 0) >= DOG_SCORE_THRESHOLD && asset.status === 'processed') dogPhotos += 1;
    if (!asset.clusterId || asset.status !== 'processed') continue;
    const score = (asset.dogScore ?? 0) + (asset.qualityScore ?? 0);
    const existing = clusters.get(asset.clusterId);
    if (!existing) {
      clusters.set(asset.clusterId, { count: 1, coverId: asset.id, coverScore: score });
    } else {
      existing.count += 1;
      if (score > existing.coverScore) {
        existing.coverId = asset.id;
        existing.coverScore = score;
      }
    }
  }

  return {
    importId: imp.id,
    provider: imp.provider as SocialProviderId,
    itemsFetched: imp.itemsFetched,
    itemsStored: imp.itemsStored,
    duplicates: imp.duplicates,
    dogPhotos,
    clusters: [...clusters.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([clusterId, c]) => ({
        clusterId,
        count: c.count,
        // Same URL shape the media module serves (mediaAssetToDto contract).
        coverUrl: `/api/media/${c.coverId}/thumb`,
        suggestedName: null,
      })),
    status: imp.status as MediaImportSummaryDto['status'],
    message: imp.message,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Import execution
 * ───────────────────────────────────────────────────────────────────────────*/

function importMessage(stored: number, dogCount: number): string {
  const photos = stored === 1 ? 'photo' : 'photos';
  const look = dogCount === 1 ? 'looks' : 'look';
  return `Imported ${stored} ${photos} — ${dogCount} ${look} like your dog`;
}

async function countDogLookingAssets(importId: string): Promise<number> {
  const rows = await db
    .select({ dogScore: mediaAssets.dogScore, status: mediaAssets.status })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.importId, importId), isNull(mediaAssets.deletedAt)));
  return rows.filter((r) => r.status === 'processed' && (r.dogScore ?? 0) >= DOG_SCORE_THRESHOLD).length;
}

/** Byte fetch for providers that hand back short-lived URLs instead of buffers. */
async function fetchExternalBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    // Same per-item ceiling the archive importer enforces.
    if (buffer.length === 0 || buffer.length > 25 * 1024 * 1024) return null;
    return buffer;
  } catch (err) {
    logger.warn({ err }, 'external media byte fetch failed — skipping item');
    return null;
  }
}

async function setImportProgress(
  importId: string,
  counters: { fetched: number; stored: number; duplicates: number },
): Promise<void> {
  await db
    .update(mediaImports)
    .set({
      itemsFetched: counters.fetched,
      itemsStored: counters.stored,
      duplicates: counters.duplicates,
      updatedAt: new Date(),
    })
    .where(eq(mediaImports.id, importId));
}

/**
 * Runs a queued account-backed import (demo / instagram / google_photos).
 * Invoked by the job worker for `social.import` jobs.
 */
export async function runSocialImport(importId: string): Promise<void> {
  const [imp] = await db.select().from(mediaImports).where(eq(mediaImports.id, importId)).limit(1);
  if (!imp) {
    logger.warn({ importId }, 'social import job for unknown import — skipping');
    return;
  }
  // Idempotent under job retries: a finished import never re-runs.
  if (imp.status === 'complete') return;

  await db.update(mediaImports).set({ status: 'running', updatedAt: new Date() }).where(eq(mediaImports.id, importId));

  try {
    const provider = getProvider(imp.provider as SocialProviderId);
    if (!imp.socialAccountId) throw new Error('import has no linked account');
    const [acct] = await db
      .select()
      .from(socialAccounts)
      .where(eq(socialAccounts.id, imp.socialAccountId))
      .limit(1);
    // A disconnect between queue and run cancels the import — consent is gone.
    if (!acct || acct.revokedAt) throw new Error('account was disconnected before the import ran');

    const counters = { fetched: 0, stored: 0, duplicates: 0 };
    let cursor: string | undefined;
    do {
      const page = await provider.getMedia(acct, cursor);
      for (const item of page.items) {
        if (counters.fetched >= MAX_ITEMS_PER_IMPORT) break;
        counters.fetched += 1;

        let buffer = item.buffer ?? null;
        if (!buffer && item.url) buffer = await fetchExternalBytes(item.url);
        if (!buffer) continue;
        const mimeType = item.mimeType ?? sniffImageMime(buffer);
        if (!mimeType) continue; // not an image we accept

        const result = await ingestImageBuffer({
          userId: imp.userId,
          buffer,
          mimeType,
          provider: imp.provider as SocialProviderId,
          externalId: item.externalId,
          importId,
          ...(item.caption ? { caption: item.caption } : {}),
          ...(item.takenAt ? { takenAt: item.takenAt } : {}),
        });
        if (result.duplicate) counters.duplicates += 1;
        else if (result.assetId) counters.stored += 1;
      }
      // Progress is visible to the polling UI after every page.
      await setImportProgress(importId, counters);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && counters.fetched < MAX_ITEMS_PER_IMPORT);

    // Classification + clustering for everything that just landed.
    await processPendingAssetsForUser(imp.userId);

    const dogCount = await countDogLookingAssets(importId);
    await db
      .update(mediaImports)
      .set({ status: 'complete', message: importMessage(counters.stored, dogCount), updatedAt: new Date() })
      .where(eq(mediaImports.id, importId));

    await db
      .update(socialAccounts)
      .set({ lastSyncedAt: new Date() })
      .where(eq(socialAccounts.id, imp.socialAccountId));
  } catch (err) {
    logger.error({ err, importId }, 'social import failed');
    // User-visible message stays generic — never a stack trace or platform body.
    await db
      .update(mediaImports)
      .set({
        status: 'failed',
        message: 'The import could not be completed. Reconnect the source and try again.',
        updatedAt: new Date(),
      })
      .where(eq(mediaImports.id, importId));
    // Rethrow so the job queue applies its retry/backoff policy.
    throw err;
  }
}

/**
 * Archive import runs inline in the upload request — the ZIP buffer is
 * request-scoped, so there is nothing a background job could re-read.
 */
export async function runArchiveImport(input: {
  actorUserId: string;
  archive: Buffer;
  requestId?: string;
}): Promise<MediaImportSummaryDto> {
  const [imp] = await db
    .insert(mediaImports)
    .values({ userId: input.actorUserId, provider: 'archive', status: 'running' })
    .returning({ id: mediaImports.id });
  const importId = imp!.id;

  // Uploading one's own data export is the consent act — record it as such.
  await db.insert(consentEvents).values({
    userId: input.actorUserId,
    kind: 'social_import',
    granted: true,
    detail: { provider: 'archive' },
  });

  const counters = { fetched: 0, stored: 0, duplicates: 0 };
  try {
    for await (const item of parseArchive(input.archive)) {
      if (counters.fetched >= MAX_ITEMS_PER_IMPORT) break;
      counters.fetched += 1;
      if (!item.buffer) continue;
      const mimeType = item.mimeType ?? sniffImageMime(item.buffer);
      if (!mimeType) continue;

      const result = await ingestImageBuffer({
        userId: input.actorUserId,
        buffer: item.buffer,
        mimeType,
        provider: 'archive',
        externalId: item.externalId,
        importId,
        ...(item.caption ? { caption: item.caption } : {}),
        ...(item.takenAt ? { takenAt: item.takenAt } : {}),
      });
      if (result.duplicate) counters.duplicates += 1;
      else if (result.assetId) counters.stored += 1;

      if (counters.fetched % 20 === 0) await setImportProgress(importId, counters);
    }
    await setImportProgress(importId, counters);

    await processPendingAssetsForUser(input.actorUserId);

    const dogCount = await countDogLookingAssets(importId);
    await db
      .update(mediaImports)
      .set({ status: 'complete', message: importMessage(counters.stored, dogCount), updatedAt: new Date() })
      .where(eq(mediaImports.id, importId));

    await recordAudit({
      actorUserId: input.actorUserId,
      action: 'social.import.archive',
      targetType: 'media_import',
      targetId: importId,
      summary: `archive import: ${counters.stored} stored, ${counters.duplicates} duplicates`,
      requestId: input.requestId ?? null,
    });
  } catch (err) {
    logger.error({ err, importId }, 'archive import failed');
    // Generic user-visible message — malformed/hostile archives get no detail.
    await db
      .update(mediaImports)
      .set({
        status: 'failed',
        message: 'We could not read that archive. Make sure it is an unmodified export ZIP and try again.',
        updatedAt: new Date(),
      })
      .where(eq(mediaImports.id, importId));
  }

  return getImportSummary({ actorUserId: input.actorUserId, importId });
}
