import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { constantTimeEqual, hashToken, randomToken } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export const SESSION_COOKIE = 'ds_session';
export const CSRF_COOKIE = 'ds_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface Actor {
  userId: string;
  sessionId: string;
  email: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  displayName: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    /** Throws 401 unless a live session is attached. */
    requireUser(): Actor;
    /** Throws 401/403 unless the actor is an active admin. */
    requireAdmin(): Actor;
  }
  interface FastifyReply {
    setSessionCookies(token: string, csrfSecret: string): FastifyReply;
    clearSessionCookies(): FastifyReply;
  }
}

/** Requests that never mutate state and therefore do not need a CSRF token. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths exempt from CSRF because no cookie-authenticated state is involved. */
const CSRF_EXEMPT = new Set([
  '/api/auth/login',
  '/api/auth/signup',
  '/api/auth/magic-link',
  '/api/auth/magic-link/consume',
  '/api/health',
]);

export const authPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.decorateRequest('actor', null);

  app.decorateRequest('requireUser', function requireUser(this: FastifyRequest): Actor {
    if (!this.actor) throw unauthorized();
    if (this.actor.status !== 'active') throw forbidden('This account is not active.');
    return this.actor;
  });

  app.decorateRequest('requireAdmin', function requireAdmin(this: FastifyRequest): Actor {
    const actor = this.requireUser();
    if (actor.role !== 'admin') {
      // 404-style denial would be nicer, but admin routes are a known surface.
      throw forbidden('Administrator access required.');
    }
    return actor;
  });

  app.decorateReply('setSessionCookies', function setSessionCookies(this: FastifyReply, token: string, csrfSecret: string) {
    this.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      path: '/',
      maxAge: Math.floor(env.sessionTtlMs / 1000),
      signed: false,
    });
    // Readable by JS on purpose: the client echoes it back in the CSRF header.
    this.setCookie(CSRF_COOKIE, csrfSecret, {
      httpOnly: false,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      path: '/',
      maxAge: Math.floor(env.sessionTtlMs / 1000),
      signed: false,
    });
    return this;
  });

  app.decorateReply('clearSessionCookies', function clearSessionCookies(this: FastifyReply) {
    this.clearCookie(SESSION_COOKIE, { path: '/' });
    this.clearCookie(CSRF_COOKIE, { path: '/' });
    return this;
  });

  /* ── Attach the session ─────────────────────────────────────────────────── */
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const extracted = extractToken(req);
    if (!extracted) return;
    const { token, fromCookie } = extracted;

    const tokenHash = hashToken(token);
    const rows = await db
      .select({
        sessionId: sessions.id,
        csrfSecret: sessions.csrfSecret,
        userId: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
        displayName: users.displayName,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return;

    req.actor = {
      userId: row.userId,
      sessionId: row.sessionId,
      email: row.email,
      role: row.role === 'admin' ? 'admin' : 'user',
      status: row.status as Actor['status'],
      displayName: row.displayName,
    };

    // Double-submit CSRF check on every state-changing cookie-authenticated
    // request. Bearer-token callers are not subject to CSRF (no ambient
    // credential for a cross-site page to abuse).
    if (fromCookie && !SAFE_METHODS.has(req.method) && !isCsrfExempt(req.url)) {
      const header = req.headers[CSRF_HEADER];
      const provided = Array.isArray(header) ? header[0] : header;
      if (!provided || !constantTimeEqual(provided, row.csrfSecret)) {
        throw forbidden('Missing or invalid CSRF token. Refresh the page and try again.');
      }
    }

    // Touch last-used at most once a minute to avoid a write per request.
    const now = Date.now();
    if (!lastTouch.has(row.sessionId) || now - (lastTouch.get(row.sessionId) ?? 0) > 60_000) {
      lastTouch.set(row.sessionId, now);
      void db
        .update(sessions)
        .set({ lastUsedAt: new Date() })
        .where(eq(sessions.id, row.sessionId))
        .catch(() => {});
      void db
        .update(users)
        .set({ lastSeenAt: new Date() })
        .where(eq(users.id, row.userId))
        .catch(() => {});
    }
  });
};

const lastTouch = new Map<string, number>();

function isCsrfExempt(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return CSRF_EXEMPT.has(path);
}

/**
 * Cookie first (browser), then `Authorization: Bearer` so a future native mobile
 * client can reuse the exact same session records (ADR 0003).
 */
function extractToken(req: FastifyRequest): { token: string; fromCookie: boolean } | null {
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) return { token: cookie, fromCookie: true };
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return { token, fromCookie: false };
  }
  return null;
}

/* ── Session lifecycle helpers (used by the auth module) ───────────────────── */

export interface IssuedSession {
  token: string;
  csrfSecret: string;
  sessionId: string;
  expiresAt: Date;
}

export async function issueSession(
  userId: string,
  meta: { userAgent?: string | null; ipHash?: string | null },
): Promise<IssuedSession> {
  const token = randomToken(32);
  const csrfSecret = randomToken(24);
  const expiresAt = new Date(Date.now() + env.sessionTtlMs);

  const [row] = await db
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashToken(token),
      csrfSecret,
      userAgent: (meta.userAgent ?? '').slice(0, 300) || null,
      ipHash: meta.ipHash ?? null,
      expiresAt,
    })
    .returning({ id: sessions.id });

  return { token, csrfSecret, sessionId: row!.id, expiresAt };
}

export async function revokeSession(sessionId: string): Promise<void> {
  lastTouch.delete(sessionId);
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** Used on password change, account deletion and admin suspension. */
export async function revokeAllSessions(userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Housekeeping job: drop sessions that expired or were revoked over a week ago. */
export async function purgeExpiredSessions(): Promise<number> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const rows = await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, new Date()), lt(sessions.revokedAt, weekAgo)))
    .returning({ id: sessions.id });
  return rows.length;
}
