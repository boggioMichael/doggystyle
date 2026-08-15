import { and, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentConfirmations, matchRequests } from '../db/schema.js';
import { recordAudit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { processPendingAssetsForUser } from '../modules/media/service.js';
import { runSocialImport } from '../modules/social/service.js';
import { purgeExpiredSessions } from '../plugins/auth.js';
import { enqueueJob } from './queue.js';
import { registerJobHandler } from './worker.js';

/**
 * All job handlers in one place, so a reader can see the complete background
 * surface of the system at a glance (ADR 0008).
 *
 * Payloads are produced only by our own enqueue sites, but they round-trip
 * through jsonb — each handler still validates with Zod so a malformed row
 * fails loudly into `dead_letter` instead of doing something half-right.
 */

/* ── Payload schemas ─────────────────────────────────────────────────────── */

const socialImportPayload = z.object({ importId: z.string().uuid() });
const mediaProcessPayload = z.object({ userId: z.string().uuid() });

/* ── Daily housekeeping ──────────────────────────────────────────────────── */

/** Pending introduction requests go stale after this long. */
const MATCH_REQUEST_TTL_MS = 14 * 24 * 3600 * 1000;

async function runDailyHousekeeping(): Promise<void> {
  const now = new Date();

  // 1. Drop sessions that expired, or were revoked over a week ago.
  const purgedSessions = await purgeExpiredSessions();

  // 2. Agent confirmations the user never answered flip pending → expired, so
  //    a parked sensitive action can never be confirmed weeks later.
  const expiredConfirmations = await db
    .update(agentConfirmations)
    .set({ status: 'expired' })
    .where(and(eq(agentConfirmations.status, 'pending'), lt(agentConfirmations.expiresAt, now)))
    .returning({ id: agentConfirmations.id });

  // 3. Introduction requests: pending for 14+ days (or past their own
  //    expiresAt) flip to expired, so the recipient's inbox self-cleans.
  const cutoff = new Date(now.getTime() - MATCH_REQUEST_TTL_MS);
  const staleIntroductions = await db
    .select({ id: matchRequests.id })
    .from(matchRequests)
    .where(
      and(
        eq(matchRequests.status, 'pending'),
        // lt() on a NULL expiresAt is simply false, so open-ended requests
        // only age out via the 14-day cutoff.
        or(lt(matchRequests.createdAt, cutoff), lt(matchRequests.expiresAt, now)),
      ),
    );

  // Row-by-row on purpose: `match_requests_pair_pending_uq` spans
  // (from_dog_id, to_dog_id, status), so a pair that already has an `expired`
  // row would make one bulk UPDATE fail wholesale. A conflicting row is
  // logged and skipped; everything else still expires.
  let expiredIntroductions = 0;
  for (const { id } of staleIntroductions) {
    try {
      const updated = await db
        .update(matchRequests)
        .set({ status: 'expired' })
        .where(and(eq(matchRequests.id, id), eq(matchRequests.status, 'pending')))
        .returning({ id: matchRequests.id });
      expiredIntroductions += updated.length;
    } catch (err) {
      logger.warn({ err, matchRequestId: id }, 'could not expire introduction request');
    }
  }

  logger.info(
    { purgedSessions, expiredConfirmations: expiredConfirmations.length, expiredIntroductions },
    'daily housekeeping complete',
  );

  // System mutation, system actor — still auditable.
  await recordAudit({
    actorUserId: null,
    action: 'system.housekeeping',
    targetType: 'system',
    summary:
      `Purged ${purgedSessions} session(s), expired ${expiredConfirmations.length} agent confirmation(s) ` +
      `and ${expiredIntroductions} introduction request(s).`,
  });

  // Book the next run ourselves — no cron needed. The date-scoped dedupe key
  // means a restart between now and then cannot double-schedule it.
  const nextRun = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3, 0, 0));
  await enqueueJob(
    'housekeeping.daily',
    {},
    { dedupeKey: `housekeeping-${nextRun.toISOString().slice(0, 10)}`, runAt: nextRun },
  );
}

/* ── Registration ────────────────────────────────────────────────────────── */

let registered = false;

/** Idempotent — `startWorker()` calls this once; calling again is a no-op. */
export function registerAllHandlers(): void {
  if (registered) return;
  registered = true;

  registerJobHandler('social.import', async (payload) => {
    const { importId } = socialImportPayload.parse(payload);
    await runSocialImport(importId);
  });

  registerJobHandler('media.process_user', async (payload) => {
    const { userId } = mediaProcessPayload.parse(payload);
    await processPendingAssetsForUser(userId);
  });

  registerJobHandler('housekeeping.daily', runDailyHousekeeping);
}
