/**
 * Matching engine — ADR 0005.
 *
 * The pipeline: SQL pool (coarse, safety filters stay in SQL) → deterministic
 * JS filter stages with per-stage counters → pure scoring → persist → phrase.
 * The AI provider is only ever asked to phrase reasons over already-computed
 * signals; it cannot change ranking, scores, or who is shown.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type {
  DogSex,
  DogSize,
  MatchCandidateDto,
  MatchIntent,
  MatchRequestStatus,
  MatchSignalDto,
  SearchResultDto,
} from '@doggystyle/shared';
import { getAiProvider } from '../../ai/index.js';
import { parsedIntentSchema, type ParsedIntent } from '../../ai/types.js';
import { db } from '../../db/client.js';
import {
  availability,
  blocks,
  breedingRecords,
  candidateMatches,
  connections,
  dogConnections,
  dogProfiles,
  dogs,
  matchRequests,
  searches,
  users,
  preferences,
} from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { boundingBox, bucketDistanceKm, distanceLabel, haversineKm, isValidLatLng } from '../../lib/geo.js';
import { logger } from '../../lib/logger.js';
import {
  matingReadiness,
  scoreCandidate,
  type AvailabilitySlot,
  type CandidateFacts,
  type PartyFacts,
} from './scoring.js';

const POOL_LIMIT = 500;
const TOP_N = 8;
const DEFAULT_RADIUS_KM = 15;

const MATING_DISCLAIMER =
  'Mating results show how complete each dog’s breeding information is. They are a starting point for a conversation between owners - not a compatibility score, and not veterinary or breeding advice.';

type ProfileRow = typeof dogProfiles.$inferSelect;
type DogRow = typeof dogs.$inferSelect;
type BreedingRow = typeof breedingRecords.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ───────────────────────────────────────────────────────────────────────────*/

/** Media urls follow the media module's contract: /api/media/<assetId>/file. */
function photoUrlFor(profilePhotoId: string | null): string | null {
  return profilePhotoId ? `/api/media/${profilePhotoId}/file` : null;
}

function toSlots(rows: Array<{ weekday: string; daypart: string }>): AvailabilitySlot[] {
  return rows.map((r) => ({
    weekday: r.weekday as AvailabilitySlot['weekday'],
    daypart: r.daypart as AvailabilitySlot['daypart'],
  }));
}

/** Only whitelisted, non-locating profile fields cross into the scoring facts. */
function toPartyFacts(name: string | null, profile: ProfileRow, slots: AvailabilitySlot[]): PartyFacts {
  return {
    name,
    sex: (profile.sex ?? 'unknown') as DogSex,
    size: (profile.size ?? null) as DogSize | null,
    ageYears: profile.ageYears,
    activityLevel: (profile.activityLevel ?? null) as PartyFacts['activityLevel'],
    sociability: (profile.sociability ?? null) as PartyFacts['sociability'],
    playStyles: (profile.playStyles ?? []) as PartyFacts['playStyles'],
    temperament: (profile.temperament ?? []) as PartyFacts['temperament'],
    interests: (profile.interests ?? []) as PartyFacts['interests'],
    goodWithSmallDogs: profile.goodWithSmallDogs,
    goodWithLargeDogs: profile.goodWithLargeDogs,
    goodWithPuppies: profile.goodWithPuppies,
    goodWithKids: profile.goodWithKids,
    availability: slots,
  };
}

interface EffectiveConstraints {
  radiusKm: number;
  minAgeYears: number | null;
  maxAgeYears: number | null;
  sizes: string[];
  sexes: string[];
  breeds: string[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * runMatchSearch
 * ───────────────────────────────────────────────────────────────────────────*/

export async function runMatchSearch(input: {
  actorUserId: string;
  dogId: string;
  parsed: ParsedIntent;
  requestId?: string;
}): Promise<SearchResultDto> {
  const { actorUserId, dogId, parsed, requestId } = input;

  /* ── Subject dog + profile (ownership gate — 404, never 403) ────────────── */
  const [subject] = await db
    .select({ dog: dogs, profile: dogProfiles })
    .from(dogs)
    .innerJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(and(eq(dogs.id, dogId), isNull(dogs.deletedAt)))
    .limit(1);
  if (!subject || subject.dog.ownerId !== actorUserId) throw notFound('Dog not found.');

  /* ── Owner preferences + own availability ───────────────────────────────── */
  const prefRows = await db
    .select()
    .from(preferences)
    .where(and(eq(preferences.userId, actorUserId), or(eq(preferences.dogId, dogId), isNull(preferences.dogId))));
  const prefs = prefRows.find((p) => p.dogId === dogId) ?? prefRows.find((p) => p.dogId === null) ?? null;

  const selfSlotRows = await db
    .select()
    .from(availability)
    .where(and(eq(availability.userId, actorUserId), or(eq(availability.dogId, dogId), isNull(availability.dogId))));
  const selfSlots = toSlots(selfSlotRows);

  /* ── Effective constraints: the parsed utterance overrides stored prefs ─── */
  const constraints: EffectiveConstraints = {
    radiusKm: parsed.radiusKm ?? prefs?.radiusKm ?? DEFAULT_RADIUS_KM,
    minAgeYears: parsed.minAgeYears ?? prefs?.minAgeYears ?? null,
    maxAgeYears: parsed.maxAgeYears ?? prefs?.maxAgeYears ?? null,
    sizes: parsed.sizes.length > 0 ? parsed.sizes : (prefs?.sizes ?? []),
    sexes: parsed.sexes.length > 0 ? parsed.sexes : (prefs?.sexes ?? []),
    breeds: parsed.breedPreference ? [parsed.breedPreference] : (prefs?.breeds ?? []),
  };

  const filteredOut: Record<string, number> = {
    no_location: 0,
    distance: 0,
    sex: 0,
    breed: 0,
    age: 0,
    mating_data: 0,
    intent: 0,
  };

  /* ── Mating gate: the subject needs breeding data before we rank anyone ─── */
  const [subjectBreeding] = await db
    .select()
    .from(breedingRecords)
    .where(eq(breedingRecords.dogId, dogId))
    .limit(1);

  if (parsed.intent === 'mating' && !subjectBreeding) {
    const searchId = await persistSearch(actorUserId, dogId, parsed, constraints, 0, filteredOut);
    return emptyResult(searchId, parsed, filteredOut, 0, [
      "Add your dog's breeding details before searching for a mating match",
    ]);
  }

  /* ── Subject location. Coarse grid coordinates only — never exact ───────── */
  const centre = { lat: subject.profile.lat ?? Number.NaN, lng: subject.profile.lng ?? Number.NaN };
  if (!isValidLatLng(centre)) {
    const searchId = await persistSearch(actorUserId, dogId, parsed, constraints, 0, filteredOut);
    return emptyResult(searchId, parsed, filteredOut, 0, [
      'Add a location to your profile so we can find dogs nearby.',
    ]);
  }

  /* ── SQL pool. Blocks and existing connections are excluded IN SQL so a
   *    blocked profile can never even enter process memory as a candidate. ── */
  const box = boundingBox(centre, constraints.radiusKm);
  const pool = await db
    .select({ dog: dogs, profile: dogProfiles })
    .from(dogProfiles)
    .innerJoin(dogs, eq(dogs.id, dogProfiles.dogId))
    .innerJoin(users, eq(users.id, dogs.ownerId))
    .where(
      and(
        eq(dogs.status, 'active'),
        isNull(dogs.deletedAt),
        eq(dogProfiles.visibility, 'public'),
        ne(dogs.ownerId, actorUserId),
        eq(users.status, 'active'),
        isNull(users.deletedAt),
        sql`${dogProfiles.lat} is not null`,
        sql`${dogProfiles.lng} is not null`,
        sql`${dogProfiles.lat} between ${box.minLat} and ${box.maxLat}`,
        sql`${dogProfiles.lng} between ${box.minLng} and ${box.maxLng}`,
        // No visibility in either direction across a block.
        sql`not exists (select 1 from ${blocks} where (${blocks.blockerUserId} = ${actorUserId} and ${blocks.blockedUserId} = ${dogs.ownerId}) or (${blocks.blockerUserId} = ${dogs.ownerId} and ${blocks.blockedUserId} = ${actorUserId}))`,
        // Already-connected pairs are managed in Connections, not re-matched.
        sql`not exists (select 1 from ${connections} where (${connections.dogAId} = ${dogId} and ${connections.dogBId} = ${dogs.id}) or (${connections.dogAId} = ${dogs.id} and ${connections.dogBId} = ${dogId}))`,
      ),
    )
    .limit(POOL_LIMIT);

  /* ── JS filter stages, counting what each one removes ───────────────────── */
  interface Survivor {
    dog: DogRow;
    profile: ProfileRow;
    distanceKm: number;
  }
  const lowerBreeds = constraints.breeds.map((b) => b.toLowerCase());
  const survivors: Survivor[] = [];

  for (const row of pool) {
    const point = { lat: row.profile.lat ?? Number.NaN, lng: row.profile.lng ?? Number.NaN };
    if (!isValidLatLng(point)) {
      filteredOut.no_location = (filteredOut.no_location ?? 0) + 1;
      continue;
    }
    const km = haversineKm(centre, point);
    if (km > constraints.radiusKm) {
      filteredOut.distance = (filteredOut.distance ?? 0) + 1;
      continue;
    }
    if (constraints.sexes.length > 0 && !constraints.sexes.includes(row.profile.sex)) {
      filteredOut.sex = (filteredOut.sex ?? 0) + 1;
      continue;
    }
    if (lowerBreeds.length > 0) {
      const breedOk =
        (row.profile.breed && lowerBreeds.includes(row.profile.breed.toLowerCase())) ||
        (row.profile.breedSecondary && lowerBreeds.includes(row.profile.breedSecondary.toLowerCase()));
      if (!breedOk) {
        filteredOut.breed = (filteredOut.breed ?? 0) + 1;
        continue;
      }
    }
    const age = row.profile.ageYears;
    if (age !== null) {
      if (
        (constraints.minAgeYears !== null && age < constraints.minAgeYears) ||
        (constraints.maxAgeYears !== null && age > constraints.maxAgeYears)
      ) {
        filteredOut.age = (filteredOut.age ?? 0) + 1;
        continue;
      }
    }
    survivors.push({ dog: row.dog, profile: row.profile, distanceKm: km });
  }

  /* ── Bulk loads for survivors: availability, breeding, meeting history ──── */
  const candDogIds = survivors.map((s) => s.dog.id);
  const ownerIds = [...new Set(survivors.map((s) => s.dog.ownerId))];

  const slotRows =
    candDogIds.length > 0
      ? await db
          .select()
          .from(availability)
          .where(
            or(
              inArray(availability.dogId, candDogIds),
              and(isNull(availability.dogId), inArray(availability.userId, ownerIds)),
            ),
          )
      : [];

  const breedingRows: BreedingRow[] =
    parsed.intent === 'mating' && candDogIds.length > 0
      ? await db.select().from(breedingRecords).where(inArray(breedingRecords.dogId, candDogIds))
      : [];
  const breedingByDog = new Map(breedingRows.map((b) => [b.dogId, b]));

  const rapportRows =
    candDogIds.length > 0
      ? await db
          .select()
          .from(dogConnections)
          .where(
            or(
              and(eq(dogConnections.dogAId, dogId), inArray(dogConnections.dogBId, candDogIds)),
              and(eq(dogConnections.dogBId, dogId), inArray(dogConnections.dogAId, candDogIds)),
            ),
          )
      : [];
  const rapportByDog = new Map(rapportRows.map((r) => [r.dogAId === dogId ? r.dogBId : r.dogAId, r]));

  /* ── Score every survivor deterministically ─────────────────────────────── */
  interface Ranked extends Survivor {
    score: number;
    signals: MatchSignalDto[];
    conflicts: string[];
    dataGaps: string[];
    completeness: number;
  }
  const subjectSex = subject.profile.sex;
  const ranked: Ranked[] = [];

  for (const s of survivors) {
    if (parsed.intent === 'mating') {
      const breeding = breedingByDog.get(s.dog.id) ?? null;
      // Intact is non-negotiable for a mating search.
      if (breeding?.reproductiveStatus !== 'intact') {
        filteredOut.mating_data = (filteredOut.mating_data ?? 0) + 1;
        continue;
      }
      // Opposite sex when the subject's sex is known; unknown candidates can't rank.
      if (subjectSex === 'male' || subjectSex === 'female') {
        const wanted = subjectSex === 'male' ? 'female' : 'male';
        if (s.profile.sex !== wanted) {
          filteredOut.intent = (filteredOut.intent ?? 0) + 1;
          continue;
        }
      }
      const readiness = matingReadiness(breeding, {
        breed: s.profile.breed,
        ageYears: s.profile.ageYears,
        sex: (s.profile.sex ?? 'unknown') as DogSex,
      });
      if (readiness.completeness <= 0) {
        filteredOut.mating_data = (filteredOut.mating_data ?? 0) + 1;
        continue;
      }
      const facts = buildFacts(s);
      const scored = scoreCandidate(facts, parsed);
      ranked.push({
        ...s,
        // For mating the "score" is purely a data-completeness meter (ADR 0005).
        score: Math.round(readiness.completeness * 100),
        signals: scored.signals,
        conflicts: scored.conflicts,
        dataGaps: readiness.gaps,
        completeness: readiness.completeness,
      });
      continue;
    }

    const facts = buildFacts(s);
    const scored = scoreCandidate(facts, parsed);
    ranked.push({ ...s, ...scored, dataGaps: [], completeness: 0 });
  }

  function buildFacts(s: Survivor): CandidateFacts {
    const candSlots = toSlots(
      slotRows.filter((r) => r.dogId === s.dog.id || (r.dogId === null && r.userId === s.dog.ownerId)),
    );
    const rapport = rapportByDog.get(s.dog.id);
    return {
      subject: toPartyFacts(subject!.dog.name, subject!.profile, selfSlots),
      candidate: toPartyFacts(s.dog.name, s.profile, candSlots),
      distanceKm: s.distanceKm,
      history: rapport
        ? { meetCount: rapport.meetCount, rapport: rapport.rapport, wantsAgain: rapport.wantsAgain }
        : null,
    };
  }

  /* ── Deterministic ordering: score, then distance, then id as tiebreak ──── */
  ranked.sort((a, b) => {
    const primary =
      parsed.intent === 'mating' ? b.completeness - a.completeness : b.score - a.score;
    if (primary !== 0) return primary;
    if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
    return a.dog.id < b.dog.id ? -1 : a.dog.id > b.dog.id ? 1 : 0;
  });
  const top = ranked.slice(0, TOP_N);

  /* ── Phrase reasons via the AI provider (phrasing only — never ranking) ─── */
  const ai = getAiProvider();
  const phrased: Array<{ reasons: string[]; conflicts: string[] }> = [];
  for (const c of top) {
    const bucketed = bucketDistanceKm(c.distanceKm);
    try {
      const explanation = await ai.explainMatch({
        subject: {
          name: subject.dog.name ?? 'Your dog',
          breed: subject.profile.breed,
          ageYears: subject.profile.ageYears,
          size: subject.profile.size,
        },
        candidate: {
          name: c.dog.name ?? 'Their dog',
          breed: c.profile.breed,
          ageYears: c.profile.ageYears,
          size: c.profile.size,
        },
        intent: parsed.intent,
        distanceLabel: distanceLabel(bucketed),
        signals: c.signals,
        hardConflicts: c.conflicts,
        dataGaps: c.dataGaps,
      });
      phrased.push({
        reasons: explanation.reasons.length > 0 ? explanation.reasons : fallbackReasons(c.signals),
        conflicts: explanation.conflicts.length > 0 ? explanation.conflicts : c.conflicts,
      });
    } catch (err) {
      // Phrasing is cosmetic: fall back to the grounded signal details.
      logger.warn({ err, requestId }, 'explainMatch failed; using signal details');
      phrased.push({ reasons: fallbackReasons(c.signals), conflicts: c.conflicts });
    }
  }

  /* ── Persist: search + candidate rows (distances bucketed BEFORE storage) ─ */
  const searchId = await persistSearch(actorUserId, dogId, parsed, constraints, pool.length, filteredOut);

  let candidateIds: string[] = [];
  if (top.length > 0) {
    const inserted = await db
      .insert(candidateMatches)
      .values(
        top.map((c, i) => ({
          searchId,
          subjectDogId: dogId,
          candidateDogId: c.dog.id,
          score: c.score,
          rank: i + 1,
          // Only the bucketed distance is ever stored — the exact value dies here.
          distanceKm: bucketDistanceKm(c.distanceKm),
          signals: c.signals as unknown[],
          reasons: phrased[i]?.reasons ?? [],
          conflicts: phrased[i]?.conflicts ?? [],
          dataGaps: c.dataGaps,
          outcome: 'shown',
        })),
      )
      .returning({ id: candidateMatches.id });
    candidateIds = inserted.map((r) => r.id);
  }

  await recordAudit({
    actorUserId,
    action: 'match.search',
    targetType: 'search',
    targetId: searchId,
    summary: `${parsed.intent} search: ${top.length} of ${pool.length} considered shown`,
    requestId: requestId ?? null,
  });

  /* ── Assemble the response DTO ──────────────────────────────────────────── */
  const candidateDtos: MatchCandidateDto[] = top.map((c, i) => {
    const bucketed = bucketDistanceKm(c.distanceKm);
    return {
      id: candidateIds[i] ?? '',
      dogId: c.dog.id,
      ownerId: c.dog.ownerId,
      name: c.dog.name ?? 'Their dog',
      breed: c.profile.breed,
      ageYears: c.profile.ageYears,
      size: (c.profile.size ?? null) as DogSize | null,
      sex: (c.profile.sex ?? 'unknown') as DogSex,
      photoUrl: photoUrlFor(c.profile.profilePhotoId),
      distanceLabel: distanceLabel(bucketed),
      distanceKm: bucketed,
      score: c.score,
      intent: parsed.intent,
      reasons: phrased[i]?.reasons ?? [],
      conflicts: phrased[i]?.conflicts ?? [],
      dataGaps: c.dataGaps,
      signals: c.signals,
      bio: c.profile.bio,
      introductionStatus: 'none',
      connectionId: null,
    };
  });

  const notes: string[] = [];
  const withinRadius = pool.length - (filteredOut.no_location ?? 0) - (filteredOut.distance ?? 0);
  if (candidateDtos.length === 0) {
    notes.push('No good matches yet - try widening your radius or relaxing your filters.');
  } else if (candidateDtos.length < 3) {
    notes.push(`Try widening your radius - only ${withinRadius} dogs within ${constraints.radiusKm} km`);
  }

  return {
    searchId,
    intent: parsed.intent,
    interpreted: parsed,
    candidates: candidateDtos,
    totalConsidered: pool.length,
    filteredOut,
    notes,
    disclaimer: parsed.intent === 'mating' ? MATING_DISCLAIMER : null,
  };
}

function fallbackReasons(signals: MatchSignalDto[]): string[] {
  return signals
    .filter((s) => s.contribution > 0.15)
    .slice(0, 4)
    .map((s) => s.detail);
}

async function persistSearch(
  userId: string,
  dogId: string,
  parsed: ParsedIntent,
  constraints: EffectiveConstraints,
  totalConsidered: number,
  filteredOut: Record<string, number>,
): Promise<string> {
  const [row] = await db
    .insert(searches)
    .values({
      userId,
      dogId,
      intent: parsed.intent,
      rawQuery: parsed.freeText || null,
      parsedIntent: parsed as unknown as Record<string, unknown>,
      constraints: constraints as unknown as Record<string, unknown>,
      totalConsidered,
      filteredOut,
    })
    .returning({ id: searches.id });
  return row!.id;
}

function emptyResult(
  searchId: string,
  parsed: ParsedIntent,
  filteredOut: Record<string, number>,
  totalConsidered: number,
  notes: string[],
): SearchResultDto {
  return {
    searchId,
    intent: parsed.intent,
    interpreted: parsed,
    candidates: [],
    totalConsidered,
    filteredOut,
    notes,
    disclaimer: parsed.intent === 'mating' ? MATING_DISCLAIMER : null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Reads: reconstruct DTOs from stored rows joined to live profiles
 * ───────────────────────────────────────────────────────────────────────────*/

type SearchRow = typeof searches.$inferSelect;

/** Owner gate for stored searches — null for anyone else (no existence oracle). */
async function loadOwnedSearch(actorUserId: string, searchId: string): Promise<SearchRow | null> {
  const [row] = await db.select().from(searches).where(eq(searches.id, searchId)).limit(1);
  if (!row || row.userId !== actorUserId) return null;
  return row;
}

interface StoredCandidateRow {
  cm: typeof candidateMatches.$inferSelect;
  dog: DogRow;
  profile: ProfileRow;
}

async function storedRowsToDtos(search: SearchRow, rows: StoredCandidateRow[]): Promise<MatchCandidateDto[]> {
  if (rows.length === 0) return [];
  const cmIds = rows.map((r) => r.cm.id);
  const candDogIds = rows.map((r) => r.dog.id);

  // Live introduction status, newest request wins per candidate row.
  const reqRows = await db
    .select()
    .from(matchRequests)
    .where(inArray(matchRequests.candidateMatchId, cmIds))
    .orderBy(desc(matchRequests.createdAt));
  const statusByCm = new Map<string, MatchRequestStatus>();
  for (const r of reqRows) {
    if (r.candidateMatchId && !statusByCm.has(r.candidateMatchId)) {
      statusByCm.set(r.candidateMatchId, r.status as MatchRequestStatus);
    }
  }

  const connRows = await db
    .select()
    .from(connections)
    .where(
      or(
        and(eq(connections.dogAId, search.dogId), inArray(connections.dogBId, candDogIds)),
        and(eq(connections.dogBId, search.dogId), inArray(connections.dogAId, candDogIds)),
      ),
    );
  const connByDog = new Map<string, string>();
  for (const c of connRows) {
    const peer = c.dogAId === search.dogId ? c.dogBId : c.dogAId;
    if (c.status === 'active' || !connByDog.has(peer)) connByDog.set(peer, c.id);
  }

  return rows.map(({ cm, dog, profile }) => ({
    id: cm.id,
    dogId: dog.id,
    ownerId: dog.ownerId,
    name: dog.name ?? 'Their dog',
    breed: profile.breed,
    ageYears: profile.ageYears,
    size: (profile.size ?? null) as DogSize | null,
    sex: (profile.sex ?? 'unknown') as DogSex,
    photoUrl: photoUrlFor(profile.profilePhotoId),
    // cm.distanceKm was bucketed before storage; safe to relabel as-is.
    distanceLabel: distanceLabel(cm.distanceKm),
    distanceKm: cm.distanceKm,
    score: cm.score,
    intent: search.intent as MatchIntent,
    reasons: cm.reasons,
    conflicts: cm.conflicts,
    dataGaps: cm.dataGaps,
    signals: cm.signals as MatchSignalDto[],
    bio: profile.bio,
    introductionStatus: statusByCm.get(cm.id) ?? 'none',
    connectionId: connByDog.get(dog.id) ?? null,
  }));
}

export async function getSearchResult(input: {
  actorUserId: string;
  searchId: string;
}): Promise<SearchResultDto | null> {
  const search = await loadOwnedSearch(input.actorUserId, input.searchId);
  if (!search) return null;

  const rows = await db
    .select({ cm: candidateMatches, dog: dogs, profile: dogProfiles })
    .from(candidateMatches)
    .innerJoin(dogs, eq(dogs.id, candidateMatches.candidateDogId))
    .innerJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(eq(candidateMatches.searchId, search.id))
    .orderBy(candidateMatches.rank);

  return {
    searchId: search.id,
    intent: search.intent as MatchIntent,
    interpreted: parsedIntentSchema.parse(search.parsedIntent),
    candidates: await storedRowsToDtos(search, rows),
    totalConsidered: search.totalConsidered,
    filteredOut: search.filteredOut,
    notes: [],
    disclaimer: search.intent === 'mating' ? MATING_DISCLAIMER : null,
  };
}

export async function getSearchCandidate(input: {
  actorUserId: string;
  searchId: string;
  candidateDogId?: string;
  rank?: number;
}): Promise<MatchCandidateDto | null> {
  const search = await loadOwnedSearch(input.actorUserId, input.searchId);
  if (!search) return null;

  const rows = await db
    .select({ cm: candidateMatches, dog: dogs, profile: dogProfiles })
    .from(candidateMatches)
    .innerJoin(dogs, eq(dogs.id, candidateMatches.candidateDogId))
    .innerJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(
      and(
        eq(candidateMatches.searchId, search.id),
        input.candidateDogId
          ? eq(candidateMatches.candidateDogId, input.candidateDogId)
          : eq(candidateMatches.rank, input.rank ?? 1),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null; // includes a requested rank beyond the stored range
  const dtos = await storedRowsToDtos(search, [row]);
  return dtos[0] ?? null;
}
