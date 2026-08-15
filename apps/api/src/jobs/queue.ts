import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { jobs } from '../db/schema.js';
import { internal } from '../lib/errors.js';

/**
 * Postgres-backed job queue (ADR 0008).
 *
 * Enqueueing is a plain INSERT, which means a job can be created inside the
 * same transaction as the write it belongs to — no dual-write problem, no
 * Redis. The worker in ./worker.js claims rows with
 * `SELECT … FOR UPDATE SKIP LOCKED`, so any number of worker processes can
 * share the table without double-running a job.
 *
 * Status vocabulary: pending → running → completed | dead_letter
 * (a failed attempt flips the row back to pending with a later runAt).
 */

export interface EnqueueOptions {
  /** Earliest time the job may run. Defaults to now. */
  runAt?: Date;
  /**
   * Idempotency key (unique index `jobs_dedupe_uq`). A second enqueue with the
   * same key is a no-op that returns the id of the job already queued — or
   * already finished, which is exactly what "at most once per key" means.
   */
  dedupeKey?: string;
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/** Insert a job and return its id; deduplicates on `opts.dedupeKey` when given. */
export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string> {
  const dedupeKey = opts.dedupeKey ?? null;

  const inserted = await db
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: opts.runAt ?? new Date(),
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      dedupeKey,
    })
    // NULL keys never collide on the unique index, so keyless jobs always insert.
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });

  const insertedId = inserted[0]?.id;
  if (insertedId) return insertedId;

  // Conflict path: hand back the existing row's id so enqueue stays idempotent
  // from the caller's point of view.
  if (!dedupeKey) throw internal('Job insert unexpectedly returned no row.');
  const [existing] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.dedupeKey, dedupeKey)).limit(1);
  if (!existing) throw internal('Job dedupe conflict, but the existing job row is gone.');
  return existing.id;
}
