import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { cancelMeetup, listMeetups, rescheduleMeetup, respondMeetup } from './service.js';

const idParam = z.object({ id: z.string().uuid() }).strict();
const respondBody = z.object({ accept: z.boolean() }).strict();
const rescheduleBody = z
  .object({
    startsAt: z.string().min(10),
    endsAt: z.string().min(10).optional(),
    durationMinutes: z.number().int().min(15).max(360).optional(),
  })
  .strict();
const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

export async function registerMeetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/meetups', async (req) => {
    const actor = req.requireUser();
    return listMeetups(actor.userId);
  });

  app.post('/meetups/:id/respond', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);
    const { accept } = respondBody.parse(req.body);
    return respondMeetup({ actorUserId: actor.userId, meetupId: id, accept, requestId: req.requestId });
  });

  app.patch('/meetups/:id', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);
    const body = rescheduleBody.parse(req.body);
    const startsAt = new Date(body.startsAt);
    const endsAt = body.endsAt
      ? new Date(body.endsAt)
      : new Date(startsAt.getTime() + (body.durationMinutes ?? 90) * 60_000);
    return rescheduleMeetup({ actorUserId: actor.userId, meetupId: id, startsAt, endsAt, requestId: req.requestId });
  });

  app.post('/meetups/:id/cancel', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);
    const { reason } = cancelBody.parse(req.body ?? {});
    return cancelMeetup({ actorUserId: actor.userId, meetupId: id, reason: reason ?? null, requestId: req.requestId });
  });
}
