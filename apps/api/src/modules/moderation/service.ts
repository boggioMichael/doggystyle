import { REPORT_REASONS, type ReportDto, type ReportReason } from '@doggystyle/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { blocks, dogs, matchRequests, notifications, reports, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { revokeConnectionsBetween } from '../connections/service.js';

function toReportDto(row: typeof reports.$inferSelect): ReportDto {
  return {
    id: row.id,
    reporterUserId: row.reporterUserId,
    reportedUserId: row.reportedUserId,
    reason: row.reason as ReportReason,
    detail: row.detail,
    status: row.status as ReportDto['status'],
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionNote: row.resolutionNote,
  };
}

/**
 * Blocking is bidirectional in effect: it revokes any connection, kills pending
 * introductions both ways, and the matching engine filters on it in SQL.
 */
export async function blockUser(input: {
  actorUserId: string;
  blockedUserId: string;
  reason?: string | null;
  requestId?: string | null;
}): Promise<void> {
  const { actorUserId, blockedUserId, reason = null, requestId = null } = input;

  if (actorUserId === blockedUserId) throw badRequest('You cannot block yourself.');

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, blockedUserId)).limit(1);
  if (!target) throw notFound('We could not find that account.');

  await db
    .insert(blocks)
    .values({ blockerUserId: actorUserId, blockedUserId, reason: reason ? reason.slice(0, 200) : null })
    .onConflictDoNothing();

  await revokeConnectionsBetween(actorUserId, blockedUserId, actorUserId);

  await db
    .update(matchRequests)
    .set({ status: 'declined', respondedAt: new Date() })
    .where(
      and(
        eq(matchRequests.status, 'pending'),
        or(
          and(eq(matchRequests.fromUserId, actorUserId), eq(matchRequests.toUserId, blockedUserId)),
          and(eq(matchRequests.fromUserId, blockedUserId), eq(matchRequests.toUserId, actorUserId)),
        ),
      ),
    );

  await recordAudit({
    actorUserId,
    action: 'moderation.block',
    targetType: 'user',
    targetId: blockedUserId,
    requestId,
  });
}

export async function unblockUser(input: {
  actorUserId: string;
  blockedUserId: string;
  requestId?: string | null;
}): Promise<void> {
  await db
    .delete(blocks)
    .where(and(eq(blocks.blockerUserId, input.actorUserId), eq(blocks.blockedUserId, input.blockedUserId)));
  await recordAudit({
    actorUserId: input.actorUserId,
    action: 'moderation.unblock',
    targetType: 'user',
    targetId: input.blockedUserId,
    requestId: input.requestId ?? null,
  });
}

export async function reportUser(input: {
  actorUserId: string;
  reportedUserId: string;
  reason: ReportReason;
  detail?: string | null;
  dogId?: string | null;
  requestId?: string | null;
}): Promise<ReportDto> {
  const { actorUserId, reportedUserId, reason, detail = null, dogId = null, requestId = null } = input;

  if (actorUserId === reportedUserId) throw badRequest('You cannot report yourself.');
  if (!REPORT_REASONS.includes(reason)) throw badRequest('Unknown report reason.');

  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, reportedUserId)).limit(1);
  if (!target) throw notFound('We could not find that account.');

  let reportedDogId: string | null = null;
  if (dogId) {
    const [dog] = await db
      .select({ id: dogs.id })
      .from(dogs)
      .where(and(eq(dogs.id, dogId), eq(dogs.ownerId, reportedUserId)))
      .limit(1);
    reportedDogId = dog?.id ?? null;
  }

  const [created] = await db
    .insert(reports)
    .values({
      reporterUserId: actorUserId,
      reportedUserId,
      reportedDogId,
      reason,
      detail: detail ? detail.slice(0, 2000) : null,
      status: 'open',
    })
    .returning();

  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));
  if (admins.length) {
    await db.insert(notifications).values(
      admins.map((a) => ({
        userId: a.id,
        kind: 'moderation',
        title: `New report: ${reason}`,
        body: null,
        link: '/app/admin',
      })),
    );
  }

  await recordAudit({
    actorUserId,
    action: 'moderation.report',
    targetType: 'user',
    targetId: reportedUserId,
    summary: reason,
    requestId,
  });

  return toReportDto(created!);
}

export async function listBlockedUserIds(actorUserId: string): Promise<string[]> {
  const rows = await db
    .select({ id: blocks.blockedUserId })
    .from(blocks)
    .where(eq(blocks.blockerUserId, actorUserId));
  return rows.map((r) => r.id);
}

export { toReportDto };
