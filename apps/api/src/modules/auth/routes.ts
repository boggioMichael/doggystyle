import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { consentEvents, loginTokens, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { coarsenLatLng, geohash, lookupCity } from '../../lib/geo.js';
import { sendMail } from '../../lib/mailer.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { issueSession, revokeAllSessions, revokeSession } from '../../plugins/auth.js';
import { viewerDto } from '../users/service.js';

/* ── Generic user-facing messages ────────────────────────────────────────────
 * One message per failure family, shared across causes, so responses never act
 * as an account-enumeration oracle (unknown email vs wrong password vs
 * suspended all read identically).
 * ───────────────────────────────────────────────────────────────────────────*/

const SIGNIN_FAILED = 'That email and password combination did not work.';
const SIGNUP_CONFLICT = 'That email address cannot be used right now. If it is yours, try signing in instead.';
const LINK_FAILED = 'That sign-in link is invalid, expired, or has already been used.';

/* ── Schemas ─────────────────────────────────────────────────────────────── */

const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/[0-9]/, 'Include at least one digit.');

const signupBodySchema = z
  .object({
    email: z.string().email().max(254),
    password: passwordSchema,
    displayName: z.string().trim().max(80).optional(),
    city: z.string().trim().max(80).optional(),
    ageConfirmed: z.literal(true),
    acceptTerms: z.literal(true),
  })
  .strict();

const loginBodySchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(200),
  })
  .strict();

const magicLinkBodySchema = z.object({ email: z.string().email().max(254) }).strict();

const consumeBodySchema = z.object({ token: z.string().min(16).max(200) }).strict();

const passwordChangeBodySchema = z
  .object({
    current: z.string().min(1).max(200),
    next: passwordSchema,
  })
  .strict();

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** Zod-validate a body; flattened field errors travel in the 400 payload. */
function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw badRequest('Invalid request.', result.error.flatten().fieldErrors);
  return result.data;
}

let fallbackHash: Promise<string> | null = null;
/** Throwaway scrypt hash verified when the email is unknown, keeping login timing flat. */
function dummyPasswordHash(): Promise<string> {
  fallbackHash ??= hashPassword(randomToken(24));
  return fallbackHash;
}

/** True when the error is a Postgres unique-index violation (a signup race). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  /* ── POST /auth/signup ──────────────────────────────────────────────────── */
  app.post('/auth/signup', async (req, reply) => {
    const body = parse(signupBodySchema, req.body);
    rateLimiter.check(RATE_RULES.signup, req.clientIp);

    const email = body.email.trim();
    const emailNormalized = email.toLowerCase();

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailNormalized, emailNormalized))
      .limit(1);
    // Generic on purpose — the message must not confirm the account exists.
    if (existing) throw conflict(SIGNUP_CONFLICT);

    const passwordHash = await hashPassword(body.password);

    // Coarse location only: known cities resolve to a snapped grid point and a
    // 5-char geohash. Signup never stores exact coordinates.
    let city = body.city?.trim() || null;
    let country: string | null = null;
    let lat: number | null = null;
    let lng: number | null = null;
    let gh: string | null = null;
    if (city) {
      const known = lookupCity(city);
      if (known) {
        city = known.city;
        country = known.country;
        const coarse = coarsenLatLng({ lat: known.lat, lng: known.lng });
        lat = coarse.lat;
        lng = coarse.lng;
        gh = geohash(coarse, 5);
      }
    }

    let userId: string;
    try {
      const [created] = await db
        .insert(users)
        .values({
          email,
          emailNormalized,
          passwordHash,
          displayName: body.displayName?.trim() || null,
          city,
          country,
          lat,
          lng,
          geohash: gh,
          // Self-attested 18+ — the literal-true `ageConfirmed` is the attestation.
          ageAttestedAt: new Date(),
          emailVerifiedAt: null,
        })
        .returning({ id: users.id });
      userId = created!.id;
    } catch (err) {
      // Unique-index race with a concurrent signup for the same address.
      if (isUniqueViolation(err)) throw conflict(SIGNUP_CONFLICT);
      throw err;
    }

    // Consent is an event log, not a flag — each grant is its own dated row.
    await db.insert(consentEvents).values([
      { userId, kind: 'age_18', granted: true, version: '1' },
      { userId, kind: 'terms', granted: true, version: '1' },
    ]);

    const session = await issueSession(userId, {
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipHash: req.clientIpHash,
    });
    reply.setSessionCookies(session.token, session.csrfSecret);

    await recordAudit({
      actorUserId: userId,
      action: 'auth.signup',
      targetType: 'user',
      targetId: userId,
      summary: 'account created',
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { viewer: await viewerDto(userId) };
  });

  /* ── POST /auth/login ───────────────────────────────────────────────────── */
  app.post('/auth/login', async (req, reply) => {
    const body = parse(loginBodySchema, req.body);
    const emailNormalized = body.email.trim().toLowerCase();

    // Two buckets: per-IP stops one host spraying many accounts; per-email
    // stops a distributed attack focused on a single account.
    rateLimiter.check(RATE_RULES.login, req.clientIp);
    rateLimiter.check(RATE_RULES.login, emailNormalized);

    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash, status: users.status })
      .from(users)
      .where(and(eq(users.emailNormalized, emailNormalized), isNull(users.deletedAt)))
      .limit(1);

    // Always burn one scrypt verification so unknown-email and wrong-password
    // responses take the same time.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok) throw unauthorized(SIGNIN_FAILED);
    if (user.status !== 'active') throw unauthorized(SIGNIN_FAILED); // same message: no status oracle

    const session = await issueSession(user.id, {
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipHash: req.clientIpHash,
    });
    reply.setSessionCookies(session.token, session.csrfSecret);

    await recordAudit({
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      summary: 'password sign-in',
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { viewer: await viewerDto(user.id) };
  });

  /* ── POST /auth/logout ──────────────────────────────────────────────────── */
  app.post('/auth/logout', async (req, reply) => {
    const actor = req.requireUser();
    await revokeSession(actor.sessionId);
    reply.clearSessionCookies();

    await recordAudit({
      actorUserId: actor.userId,
      action: 'auth.logout',
      targetType: 'session',
      targetId: actor.sessionId,
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { ok: true };
  });

  /* ── POST /auth/magic-link ──────────────────────────────────────────────── */
  app.post('/auth/magic-link', async (req) => {
    const body = parse(magicLinkBodySchema, req.body);
    const emailNormalized = body.email.trim().toLowerCase();

    // Per-IP against link farming; per-address against cross-IP inbox flooding.
    rateLimiter.check(RATE_RULES.magicLink, req.clientIp);
    rateLimiter.check(RATE_RULES.magicLink, emailNormalized);

    const [user] = await db
      .select({ id: users.id, email: users.email, status: users.status })
      .from(users)
      .where(and(eq(users.emailNormalized, emailNormalized), isNull(users.deletedAt)))
      .limit(1);

    let devLink: string | null = null;
    if (user && user.status === 'active') {
      const token = randomToken(32);
      await db.insert(loginTokens).values({
        emailNormalized,
        tokenHash: hashToken(token), // raw token never touches the database
        purpose: 'magic_link',
        expiresAt: new Date(Date.now() + env.magicLinkTtlMs),
      });

      const link = `${env.PUBLIC_URL}/auth?token=${token}`;
      // sendMail never throws, so the response below stays uniform.
      await sendMail({
        to: user.email,
        subject: `Sign in to ${env.BRAND_NAME}`,
        body:
          `Hi,\n\nUse this link to sign in to ${env.BRAND_NAME}:\n\n${link}\n\n` +
          `It is valid for ${env.MAGIC_LINK_TTL_MINUTES} minutes and works once. ` +
          `If you did not request it, you can safely ignore this email.\n\n— ${env.BRAND_NAME}`,
        link,
      });
      if (env.DEMO_MODE) devLink = link; // dev convenience only — never in real deployments
    }

    // Identical response whether or not the account exists.
    return devLink ? { sent: true, devLink } : { sent: true };
  });

  /* ── POST /auth/magic-link/consume ──────────────────────────────────────── */
  app.post('/auth/magic-link/consume', async (req, reply) => {
    const body = parse(consumeBodySchema, req.body);
    // Shares the sign-in budget: consuming links is a sign-in attempt.
    rateLimiter.check(RATE_RULES.login, req.clientIp);

    const tokenHash = hashToken(body.token);

    // Single-use enforced atomically: claim (set consumedAt) and read in one
    // UPDATE … RETURNING, so two concurrent consumers cannot both win.
    const [claimed] = await db
      .update(loginTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(loginTokens.tokenHash, tokenHash),
          isNull(loginTokens.consumedAt),
          gt(loginTokens.expiresAt, new Date()),
        ),
      )
      .returning({ emailNormalized: loginTokens.emailNormalized });
    if (!claimed) throw unauthorized(LINK_FAILED);

    const [user] = await db
      .select({ id: users.id, status: users.status, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.emailNormalized, claimed.emailNormalized), isNull(users.deletedAt)))
      .limit(1);
    if (!user || user.status !== 'active') throw unauthorized(LINK_FAILED); // same generic message

    // Completing a magic link proves control of the inbox.
    if (!user.emailVerifiedAt) {
      await db.update(users).set({ emailVerifiedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    }

    const session = await issueSession(user.id, {
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipHash: req.clientIpHash,
    });
    reply.setSessionCookies(session.token, session.csrfSecret);

    await recordAudit({
      actorUserId: user.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: user.id,
      summary: 'magic-link sign-in',
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { viewer: await viewerDto(user.id) };
  });

  /* ── POST /me/password ──────────────────────────────────────────────────── */
  app.post('/me/password', async (req, reply) => {
    const actor = req.requireUser();
    const body = parse(passwordChangeBodySchema, req.body);
    // Same budget as sign-in: `current` is a password oracle for a hijacked session.
    rateLimiter.check(RATE_RULES.login, actor.userId);

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, actor.userId))
      .limit(1);
    const ok = await verifyPassword(body.current, user?.passwordHash ?? null);
    if (!ok) throw badRequest('The current password is not correct.');

    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.next), updatedAt: new Date() })
      .where(eq(users.id, actor.userId));

    // A password change evicts every session (a stolen one included), then
    // re-issues a fresh one so this browser stays signed in.
    await revokeAllSessions(actor.userId);
    const session = await issueSession(actor.userId, {
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      ipHash: req.clientIpHash,
    });
    reply.setSessionCookies(session.token, session.csrfSecret);

    await recordAudit({
      actorUserId: actor.userId,
      action: 'auth.password_change',
      targetType: 'user',
      targetId: actor.userId,
      summary: 'password changed; all sessions revoked',
      ipHash: req.clientIpHash,
      requestId: req.requestId,
    });

    return { ok: true };
  });
}
