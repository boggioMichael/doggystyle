/**
 * API integration tests.
 *
 * These tests exercise the real HTTP layer (Fastify inject ג€” no network) against
 * a real PostgreSQL database (the test DB defined by TEST_DATABASE_URL or the
 * default doggystyle_test). setupEnv.ts has already been run before this file
 * loads, so DATABASE_URL points at the test database.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { closeDb, sql } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import type { FastifyInstance } from 'fastify';

/* ג”€ג”€ג”€ helpers ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ */

function uid() {
  return randomBytes(8).toString('hex');
}

/**
 * Sign up a fresh account.
 * Signup returns: { viewer: { id, email, ... } } with status 200.
 */
async function signup(app: FastifyInstance, overrides: { email?: string; password?: string } = {}) {
  const email = overrides.email ?? `test-${uid()}@test.local`;
  const password = overrides.password ?? 'Test1234567!';
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    payload: { email, password, ageConfirmed: true, acceptTerms: true },
  });
  expect(res.statusCode, `signup failed (${res.statusCode}): ${res.body}`).toBe(200);
  const setCookie = res.headers['set-cookie'] as string | string[];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ''];
  const csrfCookie = cookies.find((c) => c.startsWith('ds_csrf=')) ?? '';
  const csrf = csrfCookie.split(';')[0]!.slice('ds_csrf='.length);
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  const body = JSON.parse(res.body) as { viewer: { id: string } };
  return { email, password, cookie: cookieHeader, csrf, userId: body.viewer.id };
}

/** Authenticated inject helper. */
async function authed(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  session: { cookie: string; csrf: string },
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

/* ג”€ג”€ג”€ setup ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ג”€ */

let app: FastifyInstance;

beforeAll(async () => {
  await sql`create schema if not exists public`;
  await runMigrations();
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await closeDb();
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 1. Health endpoint
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('health endpoint', () => {
  it('GET /api/health returns 200 with db:ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string; checks: Array<{ name: string; ok: boolean }> };
    expect(body.status).toBe('ok');
    const dbCheck = body.checks.find((c) => c.name === 'database');
    expect(dbCheck?.ok).toBe(true);
  });

  it('GET /api/config returns brand info', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { brand: { name: string } };
    expect(body.brand.name).toBeTruthy();
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 2. Authentication and CSRF enforcement
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('authentication', () => {
  it('signup creates an account and returns a viewer + session cookies', async () => {
    const email = `auth-${uid()}@test.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email, password: 'Test1234567!', ageConfirmed: true, acceptTerms: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { viewer: { email: string } };
    expect(body.viewer.email).toBe(email);

    const setCookies = res.headers['set-cookie'] as string[];
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
    expect(cookies.some((c) => c.startsWith('ds_session='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('ds_csrf='))).toBe(true);
  });

  it('login ג†’ viewer endpoint works end-to-end', async () => {
    const { email, password, cookie, csrf } = await signup(app);
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const loginBody = JSON.parse(loginRes.body) as { viewer: { email: string } };
    expect(loginBody.viewer.email).toBe(email);

    // Verify /api/me returns the correct user
    const meRes = await authed(app, 'GET', '/api/me', { cookie, csrf });
    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body) as { id: string; email: string };
    expect(meBody.email).toBe(email);
  });

  it('wrong password returns 401 with a generic, non-revealing message', async () => {
    const { email } = await signup(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'WrongPassword99!' },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { message: string } };
    // Generic message — must not reveal which field is wrong (no account enumeration)
    const msg = body.error.message.toLowerCase();
    expect(msg).not.toContain('wrong'); expect(msg).not.toContain('incorrect'); expect(msg).not.toContain('not found');
  });

  it('weak password is rejected at signup with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `weak-${uid()}@test.local`, password: 'short', ageConfirmed: true, acceptTerms: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('signup without age confirmation is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `noage-${uid()}@test.local`, password: 'Test1234567!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('/api/me without a session returns 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('CSRF: state-changing request with cookie but wrong CSRF header is rejected with 403', async () => {
    const { cookie } = await signup(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-csrf-token': 'definitely-wrong-csrf-token' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSRF: state-changing request with cookie but missing CSRF header is rejected with 403', async () => {
    const { cookie } = await signup(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('CSRF: Bearer-token request succeeds without the CSRF header (no ambient credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `bearer-${uid()}@test.local`, password: 'BearerTest123!', ageConfirmed: true, acceptTerms: true },
    });
    expect(res.statusCode).toBe(200);
    const setCookies = res.headers['set-cookie'] as string[];
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
    const sessionToken = cookies
      .find((c) => c.startsWith('ds_session='))
      ?.split(';')[0]
      ?.slice('ds_session='.length);
    expect(sessionToken).toBeTruthy();

    // GET with Bearer token, no CSRF header ג€” must succeed because bearer tokens
    // are not subject to CSRF (they carry no ambient browser credential)
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(meRes.statusCode).toBe(200);
  });

  it('logout clears the session', async () => {
    const { cookie, csrf } = await signup(app);
    const logoutRes = await authed(app, 'POST', '/api/auth/logout', { cookie, csrf });
    expect(logoutRes.statusCode).toBe(200);

    // After logout the same cookie must no longer authenticate
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(meRes.statusCode).toBe(401);
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 3. Dog ownership / access control (IDOR prevention)
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('dog ownership and IDOR', () => {
  it('owner can create and read their own dog profile', async () => {
    const owner = await signup(app);

    const createRes = await authed(app, 'POST', '/api/dogs', owner, { name: 'Buddy' });
    expect(createRes.statusCode).toBe(201);
    const profile = JSON.parse(createRes.body) as { id: string };
    expect(profile.id).toBeTruthy();

    const readRes = await authed(app, 'GET', `/api/dogs/${profile.id}`, owner);
    expect(readRes.statusCode).toBe(200);
    const readBody = JSON.parse(readRes.body) as { id: string; name: string | null };
    expect(readBody.id).toBe(profile.id);
  });

  it("different user cannot read another user's dog ג€” IDOR returns 404", async () => {
    const owner = await signup(app);
    const attacker = await signup(app);

    const createRes = await authed(app, 'POST', '/api/dogs', owner, { name: 'PrivateDog' });
    expect(createRes.statusCode).toBe(201);
    const dogId = (JSON.parse(createRes.body) as { id: string }).id;

    const attackRes = await authed(app, 'GET', `/api/dogs/${dogId}`, attacker);
    // Must return 404 (not 403) so dog IDs are not confirmed to exist
    expect(attackRes.statusCode).toBe(404);
  });

  it("different user cannot update another user's dog attributes ג€” IDOR returns 404", async () => {
    const owner = await signup(app);
    const attacker = await signup(app);

    const createRes = await authed(app, 'POST', '/api/dogs', owner, { name: 'PatchTarget' });
    const dogId = (JSON.parse(createRes.body) as { id: string }).id;

    const attackRes = await authed(app, 'PATCH', `/api/dogs/${dogId}/attributes`, attacker, {
      updates: [{ key: 'name', value: 'Stolen' }],
    });
    expect(attackRes.statusCode).toBe(404);
  });

  it('unauthenticated user cannot create dogs', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/dogs', payload: { name: 'Ghost' } });
    expect(r.statusCode).toBe(401);
  });

  it('unauthenticated user cannot read a dog by ID', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/dogs/00000000-0000-0000-0000-000000000001',
    });
    expect(r.statusCode).toBe(401);
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 4. Matching search
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('matching search', () => {
  it('search without a dog returns 400 with a descriptive message', async () => {
    const actor = await signup(app);
    const res = await authed(app, 'POST', '/api/matches/search', actor, {
      query: 'Find my dog a playdate',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { message: string } };
    expect(body.error.message).toMatch(/profile/i);
  });

  it('search returns structured results when a dog exists', async () => {
    const actor = await signup(app);
    const createRes = await authed(app, 'POST', '/api/dogs', actor, { name: 'Searcher' });
    expect(createRes.statusCode).toBe(201);

    const res = await authed(app, 'POST', '/api/matches/search', actor, {
      query: 'Find my dog some friendly dogs nearby',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { candidates: unknown[]; searchId: string };
    expect(typeof body.searchId).toBe('string');
    expect(Array.isArray(body.candidates)).toBe(true);
  });

  it('unauthenticated search request returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/matches/search',
      payload: { query: 'find dogs' },
    });
    expect(res.statusCode).toBe(401);
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 5. Report and block
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('report and block', () => {
  it('user can block another user', async () => {
    const actor = await signup(app);
    const target = await signup(app);

    const res = await authed(app, 'POST', '/api/moderation/block', actor, { userId: target.userId });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { ok: boolean }).ok).toBe(true);
  });

  it('user can unblock a previously blocked user', async () => {
    const actor = await signup(app);
    const target = await signup(app);

    await authed(app, 'POST', '/api/moderation/block', actor, { userId: target.userId });
    const res = await authed(app, 'POST', '/api/moderation/unblock', actor, { userId: target.userId });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { ok: boolean }).ok).toBe(true);
  });

  it('user can report another user with a valid reason', async () => {
    const actor = await signup(app);
    const target = await signup(app);

    const res = await authed(app, 'POST', '/api/moderation/report', actor, {
      userId: target.userId,
      reason: 'spam',
      detail: 'Sending unwanted messages.',
    });
    // reportUser returns the created ReportDto with default 200
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { id: string; reason: string };
    expect(body.id).toBeTruthy();
    expect(body.reason).toBe('spam');
  });

  it('report with an invalid reason is rejected with 400', async () => {
    const actor = await signup(app);
    const target = await signup(app);

    const res = await authed(app, 'POST', '/api/moderation/report', actor, {
      userId: target.userId,
      reason: 'not_a_real_reason',
    });
    expect(res.statusCode).toBe(400);
  });

  it('user cannot report themselves', async () => {
    const actor = await signup(app);
    const res = await authed(app, 'POST', '/api/moderation/report', actor, {
      userId: actor.userId,
      reason: 'spam',
    });
    expect(res.statusCode).toBe(400);
  });

  it('unauthenticated block attempt returns 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/moderation/block',
      payload: { userId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(401);
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 6. Privacy: exact-location and private-data leakage prevention
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('privacy: no exact location or private data leakage', () => {
  it('/api/me never returns exactLat / exactLng fields', async () => {
    const actor = await signup(app);
    const res = await authed(app, 'GET', '/api/me', actor);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('exactLat');
    expect(res.body).not.toContain('exactLng');
  });

  it('/api/me is scoped to the session ג€” two users get their own records', async () => {
    const userA = await signup(app);
    const userB = await signup(app);

    const resA = await authed(app, 'GET', '/api/me', userA);
    const resB = await authed(app, 'GET', '/api/me', userB);
    const bodyA = JSON.parse(resA.body) as { id: string };
    const bodyB = JSON.parse(resB.body) as { id: string };

    expect(bodyA.id).toBe(userA.userId);
    expect(bodyB.id).toBe(userB.userId);
    expect(bodyA.id).not.toBe(bodyB.id);
  });

  it('match results do not contain exact coordinates', async () => {
    const actor = await signup(app);
    await authed(app, 'POST', '/api/dogs', actor, { name: 'Searcher2' });

    const res = await authed(app, 'POST', '/api/matches/search', actor, {
      query: 'Find my dog nearby dogs',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('exactLat');
    expect(res.body).not.toContain('exactLng');
  });

  it('session cookie is HttpOnly ג€” not readable by JavaScript', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `httponly-${uid()}@test.local`, password: 'Test1234567!', ageConfirmed: true, acceptTerms: true },
    });
    const cookies = res.headers['set-cookie'] as string[];
    const sessionCookie = (Array.isArray(cookies) ? cookies : [cookies]).find((c) =>
      c.startsWith('ds_session='),
    );
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie!.toLowerCase()).toContain('httponly');
  });

  it('CSRF cookie is NOT HttpOnly ג€” client JS must be able to read it for double-submit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      payload: { email: `csrf-${uid()}@test.local`, password: 'Test1234567!', ageConfirmed: true, acceptTerms: true },
    });
    const cookies = res.headers['set-cookie'] as string[];
    const csrfCookie = (Array.isArray(cookies) ? cookies : [cookies]).find((c) => c.startsWith('ds_csrf='));
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie!.toLowerCase()).not.toContain('httponly');
  });

  it('error responses do not include stack traces or internal paths', async () => {
    // Trigger a 400 by sending a malformed body
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { bad: 'request' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('at ');            // no stack frames
    expect(res.body).not.toContain('node_modules');    // no internal paths
    expect(res.body).not.toContain('apps/api/src');    // no source paths
  });
});

/* ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•
 * 7. Chat / conversational threads
 * ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•ג•*/

describe('chat threads', () => {
  it('authenticated user can create a chat thread', async () => {
    const actor = await signup(app);
    const res = await authed(app, 'POST', '/api/chat/threads', actor);
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { id: string };
    expect(body.id).toBeTruthy();
  });

  it('authenticated user can list their threads', async () => {
    const actor = await signup(app);
    await authed(app, 'POST', '/api/chat/threads', actor);

    const res = await authed(app, 'GET', '/api/chat/threads', actor);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('unauthenticated access to chat threads returns 401', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/api/chat/threads' });
    expect(r1.statusCode).toBe(401);

    const r2 = await app.inject({ method: 'POST', url: '/api/chat/threads' });
    expect(r2.statusCode).toBe(401);
  });
});
