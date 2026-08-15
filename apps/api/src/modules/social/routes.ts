import { SOCIAL_PROVIDER_IDS } from '@doggystyle/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, isAppError, payloadTooLarge } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import {
  completeOAuthCallback,
  connectProvider,
  disconnectProvider,
  getImportSummary,
  getProviderDescriptors,
  runArchiveImport,
} from './service.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Schemas
 * ───────────────────────────────────────────────────────────────────────────*/

const providerParams = z.object({ provider: z.enum(SOCIAL_PROVIDER_IDS) }).strict();

const importIdParams = z.object({ importId: z.string().uuid() }).strict();

// Deliberately non-strict: OAuth providers append extra query params we ignore.
const oauthCallbackQuery = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(4096),
});

/**
 * Archive uploads are legitimately far larger than a single photo — a
 * per-request `req.file({ limits })` override lifts the global multipart
 * `fileSize` (env.maxUploadBytes) to a hard 512 MB cap for this route only.
 */
const ARCHIVE_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────*/

function parseParams<S extends z.ZodTypeAny>(schema: S, params: unknown): z.infer<S> {
  const result = schema.safeParse(params ?? {});
  if (!result.success) throw badRequest('Invalid request parameters.', result.error.flatten());
  return result.data;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Routes
 * ───────────────────────────────────────────────────────────────────────────*/

export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  // Meta delivers the deauthorize/data-deletion webhooks below as
  // form-encoded POSTs and Fastify ships no urlencoded parser by default.
  // Parse to a raw string — the stubs acknowledge and audit, nothing more.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, body),
    );
  }

  /** All providers with per-user connection state. */
  app.get('/social/providers', async (req) => {
    const actor = req.requireUser();
    return getProviderDescriptors(actor.userId);
  });

  /** Start connecting a source: demo imports immediately, OAuth redirects. */
  app.post('/social/:provider/connect', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { provider } = parseParams(providerParams, req.params);
    return connectProvider({ actorUserId: actor.userId, provider, requestId: req.requestId });
  });

  app.post('/social/:provider/disconnect', async (req, reply) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.write, actor.userId);
    const { provider } = parseParams(providerParams, req.params);
    await disconnectProvider({ actorUserId: actor.userId, provider, requestId: req.requestId });
    reply.status(204).send();
  });

  /** Owner-only; a foreign import id yields 404 (no id enumeration). */
  app.get('/social/imports/:importId', async (req) => {
    const actor = req.requireUser();
    const { importId } = parseParams(importIdParams, req.params);
    return getImportSummary({ actorUserId: actor.userId, importId });
  });

  /**
   * Data-export ZIP upload. Parsed and ingested inline — NOT via a job — the
   * buffer is request-scoped and never touches disk in raw form.
   */
  app.post('/social/archive/upload', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.upload, actor.userId);

    const part = await req.file({ limits: { fileSize: ARCHIVE_MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw badRequest('Attach your export ZIP as the "archive" file field.');
    if (part.fieldname !== 'archive') throw badRequest('The ZIP must be sent as the "archive" file field.');

    let archive: Buffer;
    try {
      archive = await part.toBuffer();
    } catch {
      // toBuffer throws when the stream trips the per-request size limit.
      throw payloadTooLarge('That archive exceeds the 512 MB limit.');
    }
    if (part.file.truncated) throw payloadTooLarge('That archive exceeds the 512 MB limit.');

    return runArchiveImport({ actorUserId: actor.userId, archive, requestId: req.requestId });
  });

  /* ── OAuth callbacks ────────────────────────────────────────────────────── */

  for (const provider of ['instagram', 'google_photos'] as const) {
    app.get(`/social/${provider}/callback`, async (req, reply) => {
      // The user lands here via a top-level redirect, so the SameSite=Lax
      // session cookie rides along. No session → back to the app, no detail.
      if (!req.actor || req.actor.status !== 'active') {
        return reply.redirect(`/app?connect_error=${provider}`, 302);
      }
      // A GET that mutates state (account link + import) still gets rate-limited.
      rateLimiter.check(RATE_RULES.write, req.actor.userId);

      const query = (req.query ?? {}) as Record<string, unknown>;
      // The user declined at the provider — not an application error.
      if (typeof query.error === 'string') {
        return reply.redirect(`/app?connect_error=${provider}`, 302);
      }

      const parsed = oauthCallbackQuery.safeParse(query);
      if (!parsed.success) return reply.redirect(`/app?connect_error=${provider}`, 302);

      try {
        await completeOAuthCallback({
          actorUserId: req.actor.userId,
          provider,
          code: parsed.data.code,
          state: parsed.data.state,
          requestId: req.requestId,
        });
      } catch (err) {
        // Mid-navigation, a JSON error envelope is useless — log and bounce
        // back to the app with a generic marker. No provider detail leaks.
        req.log.warn({ err: isAppError(err) ? err.code : err, provider }, 'oauth callback failed');
        return reply.redirect(`/app?connect_error=${provider}`, 302);
      }

      return reply.redirect(`/app?connected=${provider}`, 302);
    });
  }

  /* ── Meta compliance webhooks ───────────────────────────────────────────── */
  // Meta requires a deauthorize URL and a data-deletion URL to exist before an
  // app can go live. These are unauthenticated stubs: acknowledge with 200 and
  // leave an audit trail. Signed-request signature verification is a TODO for
  // when the Instagram app leaves development mode.

  app.post('/social/instagram/deauthorize', async (req) => {
    rateLimiter.check(RATE_RULES.write, req.clientIp);
    await recordAudit({
      actorUserId: null,
      action: 'social.instagram.deauthorize',
      targetType: 'webhook',
      summary: 'instagram deauthorize webhook received',
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });
    return { success: true };
  });

  app.post('/social/instagram/data-deletion', async (req) => {
    rateLimiter.check(RATE_RULES.write, req.clientIp);
    // The request id doubles as the confirmation code — it ties Meta's receipt
    // to exactly one audit row on our side.
    const confirmationCode = req.requestId;
    await recordAudit({
      actorUserId: null,
      action: 'social.instagram.data_deletion',
      targetType: 'webhook',
      summary: `instagram data-deletion webhook received (confirmation ${confirmationCode})`,
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });
    // Meta expects a status URL plus confirmation code in the response body.
    return { url: `${env.PUBLIC_URL}/app?deletion=${confirmationCode}`, confirmation_code: confirmationCode };
  });
}
