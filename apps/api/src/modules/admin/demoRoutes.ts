import { and, eq, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { matchRequests, meetupParticipants, meetups, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { respondIntroduction } from '../connections/service.js';
import { respondMeetup } from '../meetups/service.js';

/** Seeded accounts, and only these, may be puppeted by the demo controls. */
const DEMO_EMAIL_SUFFIX = '@demo.doggystyle.local';

const idParam = z.object({ id: z.string().uuid() }).strict();

async function assertSeededDemoUser(userId: string): Promise<void> {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  // A real person must never be acted on by the "simulate" buttons.
  if (!user || !user.email.endsWith(DEMO_EMAIL_SUFFIX)) {
    throw notFound('That is not a demo account.');
  }
}

export async function registerDemoRoutes(app: FastifyInstance): Promise<void> {
  const guard = () => {
    if (!env.DEMO_MODE) throw notFound('Not found.');
  };

  /**
   * Simulate the other owner accepting an introduction.
   * Only valid when the actor is the requester and the target is a seeded user.
   */
  app.post('/demo/introductions/:id/accept', async (req) => {
    guard();
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);

    const [request] = await db.select().from(matchRequests).where(eq(matchRequests.id, id)).limit(1);
    if (!request) throw notFound('That introduction request no longer exists.');
    if (request.fromUserId !== actor.userId) throw notFound('That introduction request no longer exists.');
    if (request.status !== 'pending') throw conflict('That request has already been answered.');

    await assertSeededDemoUser(request.toUserId);

    const result = await respondIntroduction({
      actorUserId: request.toUserId,
      requestId: id,
      accept: true,
      httpRequestId: req.requestId,
    });

    await recordAudit({
      actorUserId: actor.userId,
      action: 'demo.simulate_intro_accept',
      targetType: 'match_request',
      targetId: id,
      requestId: req.requestId,
    });

    return result;
  });

  /** Simulate the other owner accepting a meetup. */
  app.post('/demo/meetups/:id/accept', async (req) => {
    guard();
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);

    const [mine] = await db
      .select({ userId: meetupParticipants.userId })
      .from(meetupParticipants)
      .where(and(eq(meetupParticipants.meetupId, id), eq(meetupParticipants.userId, actor.userId)))
      .limit(1);
    if (!mine) throw notFound('We could not find that meetup.');

    const [pending] = await db
      .select({ userId: meetupParticipants.userId })
      .from(meetupParticipants)
      .where(
        and(
          eq(meetupParticipants.meetupId, id),
          eq(meetupParticipants.response, 'pending'),
          ne(meetupParticipants.userId, actor.userId),
        ),
      )
      .limit(1);
    if (!pending) throw conflict('Nobody is waiting to respond to that meetup.');

    await assertSeededDemoUser(pending.userId);

    const result = await respondMeetup({
      actorUserId: pending.userId,
      meetupId: id,
      accept: true,
      requestId: req.requestId,
    });

    await recordAudit({
      actorUserId: actor.userId,
      action: 'demo.simulate_meetup_accept',
      targetType: 'meetup',
      targetId: id,
      requestId: req.requestId,
    });

    return result;
  });
}
