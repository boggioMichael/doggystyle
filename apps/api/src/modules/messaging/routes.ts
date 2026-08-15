import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { proposeMeetup } from '../meetups/service.js';
import { listMessages, sendMessage } from './service.js';

const connectionParam = z.object({ connectionId: z.string().uuid() }).strict();
const sendBody = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
const meetupBody = z
  .object({
    startsAt: z.string().datetime({ offset: true }).or(z.string().min(10)),
    endsAt: z.string().datetime({ offset: true }).or(z.string().min(10)).optional(),
    durationMinutes: z.number().int().min(15).max(360).optional(),
    title: z.string().trim().max(120).optional(),
    locationNote: z.string().trim().max(300).optional(),
  })
  .strict();

export async function registerMessagingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/connections/:connectionId/messages', async (req) => {
    const actor = req.requireUser();
    const { connectionId } = connectionParam.parse(req.params);
    return listMessages({ actorUserId: actor.userId, connectionId });
  });

  app.post('/connections/:connectionId/messages', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.message, actor.userId);
    const { connectionId } = connectionParam.parse(req.params);
    const { body } = sendBody.parse(req.body);
    return sendMessage({ actorUserId: actor.userId, connectionId, body, requestId: req.requestId });
  });

  /** Proposing a meetup lives under the connection it belongs to. */
  app.post('/connections/:connectionId/meetups', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { connectionId } = connectionParam.parse(req.params);
    const body = meetupBody.parse(req.body);

    const startsAt = new Date(body.startsAt);
    const endsAt = body.endsAt
      ? new Date(body.endsAt)
      : new Date(startsAt.getTime() + (body.durationMinutes ?? 90) * 60_000);

    return proposeMeetup({
      actorUserId: actor.userId,
      connectionId,
      startsAt,
      endsAt,
      title: body.title ?? null,
      locationNote: body.locationNote ?? null,
      requestId: req.requestId,
    });
  });
}
