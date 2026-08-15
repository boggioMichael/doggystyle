/**
 * Matching routes.
 *
 * POST /matches/search                                — parse the utterance, run the engine
 * GET  /matches/searches/:searchId                    — re-read a stored search
 * POST /matches/candidates/:candidateMatchId/introduce — request an introduction
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MatchIntent } from '@doggystyle/shared';
import { getAiProvider } from '../../ai/index.js';
import { db } from '../../db/client.js';
import { candidateMatches, preferences, searches, users } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { RATE_RULES, rateLimiter } from '../../lib/rateLimit.js';
import { requestIntroduction } from '../connections/service.js';
import { getDogProfileDto, getPrimaryDog } from '../dogs/service.js';
import { getSearchResult, runMatchSearch } from './engine.js';

const searchBodySchema = z
  .object({
    dogId: z.string().uuid().optional(),
    query: z.string().min(1).max(500),
  })
  .strict();

const searchParamsSchema = z.object({ searchId: z.string().uuid() });

const introduceParamsSchema = z.object({ candidateMatchId: z.string().uuid() });

const introduceBodySchema = z
  .object({
    message: z.string().max(300).optional(),
  })
  .strict();

export async function registerMatchingRoutes(app: FastifyInstance): Promise<void> {
  /* ── Run a search ───────────────────────────────────────────────────────── */
  app.post('/matches/search', async (req) => {
    const actor = req.requireUser();
    rateLimiter.check(RATE_RULES.search, actor.userId);
    const body = searchBodySchema.parse(req.body);

    // Resolve the subject dog: explicit id (owner-checked) or the primary dog.
    let dogId: string;
    let dogName: string | null;
    let dogBreed: string | null;
    let dogAgeYears: number | null;
    if (body.dogId) {
      const profile = await getDogProfileDto(body.dogId, actor.userId); // throws notFound for non-owners
      dogId = body.dogId;
      dogName = profile.name;
      dogBreed = profile.breed;
      dogAgeYears = profile.ageYears;
    } else {
      const primary = await getPrimaryDog(actor.userId);
      if (!primary) throw badRequest("Create your dog's profile first");
      dogId = primary.dog.id;
      dogName = primary.dog.name;
      dogBreed = primary.profile.breed;
      dogAgeYears = primary.profile.ageYears;
    }

    // Context for the parser: profile facts, default radius and coarse city
    // only. Nothing here ever leaves the server — parsing is server-side.
    const prefRows = await db
      .select({ dogId: preferences.dogId, radiusKm: preferences.radiusKm })
      .from(preferences)
      .where(and(eq(preferences.userId, actor.userId), or(eq(preferences.dogId, dogId), isNull(preferences.dogId))));
    const prefs = prefRows.find((p) => p.dogId === dogId) ?? prefRows.find((p) => p.dogId === null) ?? null;

    const [userRow] = await db.select({ city: users.city }).from(users).where(eq(users.id, actor.userId)).limit(1);

    const parsed = await getAiProvider().parseIntent({
      utterance: body.query,
      context: {
        dogName,
        dogBreed,
        dogAgeYears,
        defaultRadiusKm: prefs?.radiusKm ?? 15,
        city: userRow?.city ?? null,
        now: new Date().toISOString(),
      },
    });

    return runMatchSearch({ actorUserId: actor.userId, dogId, parsed, requestId: req.requestId });
  });

  /* ── Re-read a stored search ────────────────────────────────────────────── */
  app.get('/matches/searches/:searchId', async (req) => {
    const actor = req.requireUser();
    const { searchId } = searchParamsSchema.parse(req.params);
    const result = await getSearchResult({ actorUserId: actor.userId, searchId });
    if (!result) throw notFound('Search not found.'); // covers other users' searches too
    return result;
  });

  /* ── Ask for an introduction to a shown candidate ───────────────────────── */
  app.post('/matches/candidates/:candidateMatchId/introduce', async (req) => {
    const actor = req.requireUser();
    const { candidateMatchId } = introduceParamsSchema.parse(req.params);
    const body = introduceBodySchema.parse(req.body ?? {});

    // The candidate row must come from a search the actor owns — 404 otherwise
    // so candidate ids cannot be probed.
    const [row] = await db
      .select({ cm: candidateMatches, search: searches })
      .from(candidateMatches)
      .innerJoin(searches, eq(searches.id, candidateMatches.searchId))
      .where(eq(candidateMatches.id, candidateMatchId))
      .limit(1);
    if (!row || row.search.userId !== actor.userId) throw notFound('Candidate not found.');

    rateLimiter.check(RATE_RULES.introduction, actor.userId);

    const dto = await requestIntroduction({
      actorUserId: actor.userId,
      fromDogId: row.cm.subjectDogId,
      toDogId: row.cm.candidateDogId,
      intent: row.search.intent as MatchIntent,
      candidateMatchId: row.cm.id,
      message: body.message,
      reasons: row.cm.reasons,
      requestId: req.requestId,
    });

    // Feedback loop for the recommender: this candidate converted.
    await db.update(candidateMatches).set({ outcome: 'introduced' }).where(eq(candidateMatches.id, row.cm.id));

    return dto;
  });
}
