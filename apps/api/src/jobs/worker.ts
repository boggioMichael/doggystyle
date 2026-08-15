import { eq } from 'drizzle-orm';
import { db, sql as pgsql } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { logger } from '../lib/logger.js';
// Deliberate import cycle with ./handlers.js: each side only *calls* the other
// at runtime (never during module evaluation), which ESM resolves cleanly.
import { registerAllHandlers } from './handlers.js';
import { enqueueJob } from './queue.js';

/**
 * The job worker loop (ADR 0008).
 *
 * One job at a time, claimed with `SELECT … FOR UPDATE SKIP LOCKED` inside a
 * short transaction, then executed OUTSIDE that transaction so a slow handler
 * never holds a row lock or a pooled connection hostage. Failures retry with
 * exponential backoff and park in `dead_letter` after `max_attempts`, where
 * the admin console can inspect them as plain rows.
 */

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Handler registry
 * ───────────────────────────────────────────────────────────────────────────*/

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  if (handlers.has(type)) logger.warn({ type }, 'job handler registered twice — the later one wins');
  handlers.set(type, handler);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Worker lifecycle
 * ───────────────────────────────────────────────────────────────────────────*/

const TICK_MS = 1_000;
const BASE_BACKOFF_MS = 5_000;
/** `last_error` is capped so a chatty stack trace cannot bloat the table. */
const MAX_ERROR_CHARS = 2_000;

let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;
let bootstrapped = false;

export function startWorker(): void {
  if (timer) return; // already running

  if (!bootstrapped) {
    bootstrapped = true;
    registerAllHandlers();
  }

  // Seed today's housekeeping run. The date-scoped dedupe key collapses
  // restarts (and multiple worker processes) into a single daily execution.
  const today = new Date().toISOString().slice(0, 10);
  void enqueueJob('housekeeping.daily', {}, { dedupeKey: `housekeeping-${today}` }).catch((err) =>
    logger.error({ err }, 'failed to enqueue daily housekeeping'),
  );

  timer = setInterval(() => {
    if (inFlight) return; // concurrency 1: never overlap ticks
    inFlight = tick()
      // Catch-all so a broken tick (DB down, handler bug) can never become an
      // unhandled rejection that kills the process — the loop just tries again.
      .catch((err) => logger.error({ err }, 'job worker tick failed'))
      .finally(() => {
        inFlight = null;
      });
  }, TICK_MS);
  // The poll loop must never be the thing keeping the process alive.
  timer.unref();
}

/** Stop polling, then wait for the job currently running (if any) to settle. */
export async function stopWorker(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (inFlight) await inFlight; // never rejects — see the catch in startWorker
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Claim → run → settle
 * ───────────────────────────────────────────────────────────────────────────*/

async function tick(): Promise<void> {
  const job = await claimNextJob();
  if (!job) return;

  const handler = handlers.get(job.type);
  if (!handler) {
    // No amount of retrying conjures a missing handler — dead-letter now.
    await settleFailure(job, new Error(`no handler registered for job type "${job.type}"`), {
      forceDeadLetter: true,
    });
    return;
  }

  try {
    // The handler runs outside any transaction on purpose (see module header).
    await handler(job.payload ?? {});
    await db
      .update(jobs)
      // 'complete' (not 'completed') — this is the vocabulary the jobs_status_ck
      // database constraint and JobRowDto both use.
      .set({ status: 'complete', finishedAt: new Date(), lastError: null, updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    logger.debug({ jobId: job.id, type: job.type }, 'job completed');
  } catch (err) {
    await settleFailure(job, err);
  }
}

/**
 * Claim exactly one due job. SKIP LOCKED lets a second worker (ROLE=worker
 * beside ROLE=both, or a future scale-out) share the table: a row locked by
 * one claimer is silently skipped by the others, so no job runs twice.
 *
 * Raw `postgres` template here (not drizzle) because the claim needs
 * `FOR UPDATE SKIP LOCKED` inside its own short transaction — parameters are
 * still bound, never concatenated.
 */
async function claimNextJob(): Promise<ClaimedJob | null> {
  return pgsql.begin(async (trx) => {
    const rows = await trx<ClaimedJob[]>`
      select id, type, payload, attempts, max_attempts as "maxAttempts"
      from jobs
      where status = 'pending' and run_at <= now()
      order by run_at
      limit 1
      for update skip locked
    `;
    const row = rows[0];
    if (!row) return null;

    await trx`
      update jobs
      set status = 'running', started_at = now(), updated_at = now()
      where id = ${row.id}
    `;
    return row;
  });
}

async function settleFailure(
  job: ClaimedJob,
  err: unknown,
  opts: { forceDeadLetter?: boolean } = {},
): Promise<void> {
  const attempts = job.attempts + 1;
  const lastError = describeError(err).slice(0, MAX_ERROR_CHARS);

  if (opts.forceDeadLetter || attempts >= job.maxAttempts) {
    logger.error({ jobId: job.id, type: job.type, attempts, err }, 'job dead-lettered');
    await db
      .update(jobs)
      .set({ status: 'dead_letter', attempts, lastError, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(jobs.id, job.id));
    return;
  }

  // Exponential backoff: 5 s × 2^attempts → 10 s, 20 s, 40 s, …
  const delayMs = BASE_BACKOFF_MS * 2 ** attempts;
  const runAt = new Date(Date.now() + delayMs);
  logger.warn({ jobId: job.id, type: job.type, attempts, retryInMs: delayMs, err }, 'job failed; retry scheduled');
  await db
    .update(jobs)
    .set({ status: 'pending', attempts, lastError, runAt, startedAt: null, updatedAt: new Date() })
    .where(eq(jobs.id, job.id));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
