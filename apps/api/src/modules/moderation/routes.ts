import { REPORT_REASONS } from '@doggystyle/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { blockUser, reportUser, unblockUser } from './service.js';

const blockBody = z
  .object({ userId: z.string().uuid(), reason: z.string().trim().max(200).optional() })
  .strict();

const reportBody = z
  .object({
    userId: z.string().uuid(),
    reason: z.enum(REPORT_REASONS),
    detail: z.string().trim().max(2000).optional(),
    dogId: z.string().uuid().optional(),
  })
  .strict();

export async function registerModerationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/moderation/block', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const body = blockBody.parse(req.body);
    await blockUser({
      actorUserId: actor.userId,
      blockedUserId: body.userId,
      reason: body.reason ?? null,
      requestId: req.requestId,
    });
    reply.send({ ok: true });
  });

  app.post('/moderation/unblock', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const body = blockBody.parse(req.body);
    await unblockUser({ actorUserId: actor.userId, blockedUserId: body.userId, requestId: req.requestId });
    reply.send({ ok: true });
  });

  app.post('/moderation/report', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.report, actor.userId);
    const body = reportBody.parse(req.body);
    return reportUser({
      actorUserId: actor.userId,
      reportedUserId: body.userId,
      reason: body.reason,
      detail: body.detail ?? null,
      dogId: body.dogId ?? null,
      requestId: req.requestId,
    });
  });
}
