import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import {
  createThread,
  listThreadMessages,
  listThreads,
  resolveConfirmation,
  runChatTurn,
} from './service.js';

const idParam = z.object({ id: z.string().uuid() }).strict();
const messageBody = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
const confirmBody = z.object({ confirm: z.boolean() }).strict();

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/chat/threads', async (req) => {
    const actor = req.requireUser();
    return listThreads(actor.userId);
  });

  app.post('/chat/threads', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const id = await createThread(actor.userId, env.BRAND_NAME);
    reply.status(201).send({ id });
  });

  app.get('/chat/threads/:id/messages', async (req) => {
    const actor = req.requireUser();
    const { id } = idParam.parse(req.params);
    return listThreadMessages(id, actor.userId);
  });

  app.post('/chat/threads/:id/messages', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.chat, actor.userId);
    const { id } = idParam.parse(req.params);
    const { text } = messageBody.parse(req.body);
    return runChatTurn({ actor, threadId: id, text, requestId: req.requestId });
  });

  app.post('/chat/confirmations/:id', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { id } = idParam.parse(req.params);
    const { confirm } = confirmBody.parse(req.body);
    return resolveConfirmation({ actor, confirmationId: id, confirm, requestId: req.requestId });
  });
}
