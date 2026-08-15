import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { listConnections, listIntroductions, respondIntroduction } from './service.js';

const boxQuery = z.object({ box: z.enum(['incoming', 'outgoing']).default('incoming') }).strict();
const respondBody = z.object({ accept: z.boolean() }).strict();
const idParam = z.object({ id: z.string().uuid() }).strict();

export async function registerConnectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/introductions', async (req) => {
    const actor = req.requireUser();
    const { box } = boxQuery.parse(req.query ?? {});
    return listIntroductions(actor.userId, box);
  });

  app.post('/introductions/:id/respond', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);
    const { accept } = respondBody.parse(req.body);
    return respondIntroduction({
      actorUserId: actor.userId,
      requestId: id,
      accept,
      httpRequestId: req.requestId,
    });
  });

  app.get('/connections', async (req) => {
    const actor = req.requireUser();
    return listConnections(actor.userId);
  });
}
