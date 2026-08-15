import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { hashIp } from '../lib/crypto.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    clientIp: string;
    clientIpHash: string | null;
    startedAt: number;
  }
}

/**
 * Assigns a request id to every request, echoes it back in `x-request-id`, and
 * makes it available for logs and audit rows so a user-visible error can be
 * traced to exactly one log line.
 */
export const contextPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest('requestId', '');
  app.decorateRequest('clientIp', '');
  app.decorateRequest('clientIpHash', null);
  app.decorateRequest('startedAt', 0);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    req.startedAt = Date.now();
    req.clientIp = req.ip;
    req.clientIpHash = hashIp(req.ip);
    reply.header('x-request-id', id);
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    req.log.info(
      {
        requestId: req.requestId,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs: Date.now() - req.startedAt,
        userId: req.actor?.userId ?? null,
      },
      'request',
    );
  });
};
