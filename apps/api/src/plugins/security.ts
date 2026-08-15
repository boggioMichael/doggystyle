import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { env } from '../config/env.js';
import { isAppError } from '../lib/errors.js';

/**
 * Security response headers.
 *
 * A hand-rolled set rather than @fastify/helmet: the app is served from a single
 * origin with a known asset shape, so the policy is short and auditable.
 */
export const securityHeadersPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  const csp = [
    "default-src 'self'",
    // Vite injects a nonce-less inline style for the initial paint; images are
    // served from our own origin plus data: URIs for generated placeholders.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
    reply.header('content-security-policy', csp);
    if (env.COOKIE_SECURE) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    // API responses must never be cached by a shared cache.
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });
};

/** Uniform JSON error envelope with a traceable request id. */
export const errorHandlerPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Note: the 404 handler is installed once in app.ts, because Fastify allows
  // only one per prefix and it needs to know whether the SPA is being served.
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.requestId;

    if (isAppError(err)) {
      if (err.statusCode >= 500) req.log.error({ err, requestId }, 'app error');
      else req.log.warn({ code: err.code, requestId, msg: err.message }, 'handled error');
      reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.expose ? err.message : 'Something went wrong.',
          details: err.expose ? err.details : undefined,
          requestId,
        },
      });
      return;
    }

    // Fastify/plugin validation errors
    const fastifyErr = err as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof fastifyErr.statusCode === 'number' ? fastifyErr.statusCode : 500;
    if (statusCode === 413) {
      reply.status(413).send({
        error: { code: 'payload_too_large', message: 'That file is too large.', requestId },
      });
      return;
    }
    if (statusCode >= 400 && statusCode < 500) {
      req.log.warn({ err, requestId }, 'client error');
      const message = typeof fastifyErr.message === 'string' && fastifyErr.message ? fastifyErr.message : 'Bad request.';
      reply.status(statusCode).send({
        error: { code: 'bad_request', message, requestId },
      });
      return;
    }

    req.log.error({ err, requestId }, 'unhandled error');
    reply.status(500).send({
      error: {
        code: 'internal_error',
        // Never leak internals to the client; the request id ties it to the log.
        message: 'Something went wrong on our side.',
        requestId,
      },
    });
  });
};
