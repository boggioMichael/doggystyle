import type { AdminUserRowDto, AuditEventDto, JobRowDto, ReportDto } from '@doggystyle/shared';
import { and, count, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { auditEvents, dogs, jobs, outboundEmails, reports, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { revokeAllSessions } from '../../plugins/auth.js';
import { toReportDto } from '../moderation/service.js';
import { registerDemoRoutes } from './demoRoutes.js';

const idParam = z.object({ id: z.string().uuid() }).strict();
const listQuery = z.object({ query: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict();
const reportsQuery = z.object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).optional() }).strict();
const suspendBody = z.object({ suspend: z.boolean() }).strict();
const resolveBody = z.object({ status: z.enum(['actioned', 'dismissed']), note: z.string().max(1000).optional() }).strict();

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/users', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { query, limit } = listQuery.parse(req.query ?? {});

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
        dogCount: sql<number>`(select count(*)::int from ${dogs} where ${dogs.ownerId} = ${users.id} and ${dogs.deletedAt} is null)`,
        reportsAgainst: sql<number>`(select count(*)::int from ${reports} where ${reports.reportedUserId} = ${users.id})`,
      })
      .from(users)
      .where(query ? or(ilike(users.email, `%${query}%`), ilike(users.displayName, `%${query}%`)) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit ?? 50);

    // Admin *reads* are audited too — viewing personal data is itself an action.
    await recordAudit({
      actorUserId: actor.userId,
      action: 'admin.users.list',
      summary: query ? `search: ${query}` : 'browse',
      requestId: req.requestId,
    });

    return rows.map(
      (r): AdminUserRowDto => ({
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        role: r.role === 'admin' ? 'admin' : 'user',
        status: r.status as AdminUserRowDto['status'],
        dogCount: Number(r.dogCount),
        reportsAgainst: Number(r.reportsAgainst),
        createdAt: r.createdAt.toISOString(),
        lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
      }),
    );
  });

  app.get('/admin/users/:id', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { id } = idParam.parse(req.params);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        status: users.status,
        city: users.city,
        country: users.country,
        createdAt: users.createdAt,
        lastSeenAt: users.lastSeenAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw notFound('No such user.');

    const [ownedDogs, recentAudit] = await Promise.all([
      db.select({ id: dogs.id, name: dogs.name, status: dogs.status }).from(dogs).where(eq(dogs.ownerId, id)),
      db.select().from(auditEvents).where(eq(auditEvents.actorUserId, id)).orderBy(desc(auditEvents.createdAt)).limit(20),
    ]);

    await recordAudit({
      actorUserId: actor.userId,
      action: 'admin.users.view',
      targetType: 'user',
      targetId: id,
      requestId: req.requestId,
    });

    return {
      user: { ...user, createdAt: user.createdAt.toISOString(), lastSeenAt: user.lastSeenAt?.toISOString() ?? null },
      dogs: ownedDogs,
      recentAudit: recentAudit.map(toAuditDto),
    };
  });

  app.post('/admin/users/:id/suspend', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { id } = idParam.parse(req.params);
    const { suspend } = suspendBody.parse(req.body);

    const [target] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, id)).limit(1);
    if (!target) throw notFound('No such user.');
    if (target.role === 'admin') throw conflict('Administrators cannot be suspended from here.');

    await db.update(users).set({ status: suspend ? 'suspended' : 'active', updatedAt: new Date() }).where(eq(users.id, id));
    if (suspend) await revokeAllSessions(id);

    await recordAudit({
      actorUserId: actor.userId,
      action: suspend ? 'admin.user.suspend' : 'admin.user.reinstate',
      targetType: 'user',
      targetId: id,
      requestId: req.requestId,
    });

    return { ok: true };
  });

  app.get('/admin/reports', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { status } = reportsQuery.parse(req.query ?? {});

    const rows = await db
      .select()
      .from(reports)
      .where(status ? eq(reports.status, status) : undefined)
      .orderBy(desc(reports.createdAt))
      .limit(100);

    return rows.map((r): ReportDto => toReportDto(r));
  });

  app.post('/admin/reports/:id/resolve', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { id } = idParam.parse(req.params);
    const { status, note } = resolveBody.parse(req.body);

    const [updated] = await db
      .update(reports)
      .set({ status, resolutionNote: note ?? null, resolvedByUserId: actor.userId, resolvedAt: new Date() })
      .where(eq(reports.id, id))
      .returning();
    if (!updated) throw notFound('No such report.');

    await recordAudit({
      actorUserId: actor.userId,
      action: 'admin.report.resolve',
      targetType: 'report',
      targetId: id,
      summary: status,
      requestId: req.requestId,
    });

    return toReportDto(updated);
  });

  app.get('/admin/jobs', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(100);
    return rows.map(
      (j): JobRowDto => ({
        id: j.id,
        type: j.type,
        status: j.status as JobRowDto['status'],
        attempts: j.attempts,
        lastError: j.lastError,
        runAt: j.runAt.toISOString(),
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
      }),
    );
  });

  app.get('/admin/audit', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { limit } = listQuery.parse(req.query ?? {});
    const rows = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit ?? 100);
    return rows.map(toAuditDto);
  });

  /** The dev mailbox: how you read magic-link emails without an SMTP server. */
  app.get('/admin/emails', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    return db
      .select({
        id: outboundEmails.id,
        toAddress: outboundEmails.toAddress,
        subject: outboundEmails.subject,
        link: outboundEmails.link,
        transport: outboundEmails.transport,
        createdAt: outboundEmails.createdAt,
      })
      .from(outboundEmails)
      .orderBy(desc(outboundEmails.createdAt))
      .limit(50);
  });

  app.get('/admin/emails/:id', async (req) => {
    const actor = req.requireAdmin();
    rateLimiter.check(RATE_RULES.admin, actor.userId);
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(outboundEmails).where(eq(outboundEmails.id, id)).limit(1);
    if (!row) throw notFound('No such message.');
    await recordAudit({
      actorUserId: actor.userId,
      action: 'admin.email.view',
      targetType: 'email',
      targetId: id,
      requestId: req.requestId,
    });
    return { ...row, createdAt: row.createdAt.toISOString() };
  });

  await registerDemoRoutes(app);
}

function toAuditDto(row: typeof auditEvents.$inferSelect): AuditEventDto {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    summary: row.summary,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}
