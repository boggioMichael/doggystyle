import { auditEvents } from '../db/schema.js';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';
import { logger } from './logger.js';

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ipHash?: string | null;
  requestId?: string | null;
}

/**
 * Audit writes must never break the request they describe — a failure here is
 * logged loudly but swallowed.
 */
export async function recordAudit(input: AuditInput, tx: DbOrTx = db): Promise<void> {
  try {
    await tx.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      summary: input.summary ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      ipHash: input.ipHash ?? null,
      requestId: input.requestId ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit event');
  }
}
