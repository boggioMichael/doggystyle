/**
 * Match scoring — ADR 0005.
 *
 * Everything in this file is pure and deterministic: same facts in, same score
 * out, no I/O, no randomness, no clock. The AI provider is only ever handed the
 * *outputs* of these functions to phrase — it never influences the numbers.
 */
import {
  ACTIVITY_ORDER,
  DAYPART_LABELS,
  PLAY_STYLE_AFFINITY,
  PLAY_STYLE_FRICTION,
  SIZE_ORDER,
  SOCIABILITY_ORDER,
} from '@doggystyle/shared';
import type {
  ActivityLevel,
  Daypart,
  DogSex,
  DogSize,
  Interest,
  MatchSignalDto,
  PlayStyle,
  Sociability,
  TemperamentTrait,
  Weekday,
} from '@doggystyle/shared';
import type { ParsedIntent } from '../../ai/types.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Facts — the complete, pre-fetched input. No db access happens below.
 * ───────────────────────────────────────────────────────────────────────────*/

export interface AvailabilitySlot {
  weekday: Weekday;
  daypart: Daypart;
}

/** One side of the comparison (the searching dog or a candidate). */
export interface PartyFacts {
  name: string | null;
  sex: DogSex;
  size: DogSize | null;
  ageYears: number | null;
  activityLevel: ActivityLevel | null;
  sociability: Sociability | null;
  playStyles: PlayStyle[];
  temperament: TemperamentTrait[];
  interests: Interest[];
  goodWithSmallDogs: boolean | null;
  goodWithLargeDogs: boolean | null;
  goodWithPuppies: boolean | null;
  goodWithKids: boolean | null;
  availability: AvailabilitySlot[];
}

/** Prior meetings between the two dogs, from `dog_connections`. */
export interface MeetingHistory {
  meetCount: number;
  rapport: number | null;
  wantsAgain: boolean | null;
}

export interface CandidateFacts {
  subject: PartyFacts;
  candidate: PartyFacts;
  /** Exact km, computed from coarse grid points. Never serialised — bucket before storing. */
  distanceKm: number | null;
  history: MeetingHistory | null;
}

export interface ScoreResult {
  /** 0–100. 50 is "we know nothing either way". */
  score: number;
  signals: MatchSignalDto[];
  /** Human-readable hard concerns, surfaced verbatim and given to the phraser. */
  conflicts: string[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Weights — must sum to 1 so the score stays anchored at 50 ± 50.
 * ───────────────────────────────────────────────────────────────────────────*/

const WEIGHTS = {
  activity_similarity: 0.2,
  play_style: 0.16,
  size_compat: 0.13,
  age_similarity: 0.12,
  temperament: 0.12,
  schedule_overlap: 0.12,
  sociability: 0.05,
  shared_interests: 0.05,
  history: 0.05,
} as const;

type SignalKey = keyof typeof WEIGHTS;

const LABELS: Record<SignalKey, string> = {
  activity_similarity: 'Energy levels',
  play_style: 'Play style',
  size_compat: 'Size match',
  age_similarity: 'Age',
  temperament: 'Temperament',
  schedule_overlap: 'Schedules',
  sociability: 'Sociability',
  shared_interests: 'Shared interests',
  history: 'Past meetings',
};

/** A builder returns null when there is not enough data to say anything. */
interface SignalOutcome {
  contribution: number;
  detail: string;
  conflicts?: string[];
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Small pure helpers
 * ───────────────────────────────────────────────────────────────────────────*/

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const humanise = (token: string): string => token.replace(/_/g, ' ');

/** "a", "a and b", "a, b and c" */
function humanList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function orderIndex<T>(order: readonly T[], value: T | null): number {
  if (value === null) return -1;
  return order.indexOf(value);
}

function pairMatches(
  pairs: ReadonlyArray<readonly [PlayStyle, PlayStyle]>,
  a: PlayStyle,
  b: PlayStyle,
): boolean {
  return pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

const PLAY_STYLE_WORDS: Record<PlayStyle, string> = {
  gentle: 'gentle play',
  chase: 'a good chase',
  wrestle: 'wrestling',
  fetch: 'fetch',
  tug: 'tug-of-war',
  parallel_walk: 'walking together',
  sniff_explore: 'sniffing and exploring',
  water: 'water play',
};

const INTEREST_WORDS: Partial<Record<Interest, string>> = {
  beach: 'beach days',
  dog_park: 'the dog park',
  cafe_sitting: 'café sitting',
  long_walks: 'long walks',
  car_trips: 'car trips',
  snuffle_games: 'snuffle games',
};

const WEEKDAY_WORDS: Record<Weekday, string> = {
  sun: 'Sundays',
  mon: 'Mondays',
  tue: 'Tuesdays',
  wed: 'Wednesdays',
  thu: 'Thursdays',
  fri: 'Fridays',
  sat: 'Saturdays',
};

function slotLabel(slot: NonNullable<ParsedIntent['availability']>): string {
  if (slot.label) return slot.label;
  const parts: string[] = [];
  if (slot.weekday) parts.push(`on ${WEEKDAY_WORDS[slot.weekday]}`);
  if (slot.daypart) {
    parts.push(slot.daypart === 'night' ? 'at night' : `in the ${DAYPART_LABELS[slot.daypart].toLowerCase()}`);
  }
  return parts.join(' ') || 'then';
}

const candidateName = (facts: CandidateFacts): string => facts.candidate.name ?? 'This dog';
const subjectName = (facts: CandidateFacts): string => facts.subject.name ?? 'your dog';

/* ─────────────────────────────────────────────────────────────────────────────
 * Signal builders — one per weighted signal, evaluated in a fixed order.
 * ───────────────────────────────────────────────────────────────────────────*/

function activitySignal(facts: CandidateFacts, parsed: ParsedIntent): SignalOutcome | null {
  const cand = facts.candidate.activityLevel;
  // "Looking for a calm friend": a low/moderate candidate is a positive match
  // even if the subject itself is a whirlwind.
  if (parsed.temperament.includes('calm') && (cand === 'low' || cand === 'moderate')) {
    return { contribution: 0.8, detail: 'Calm energy, as requested' };
  }
  const si = orderIndex(ACTIVITY_ORDER, facts.subject.activityLevel);
  const ci = orderIndex(ACTIVITY_ORDER, cand);
  if (si < 0 || ci < 0) return null;
  const dist = Math.abs(si - ci);
  if (dist === 0) {
    const detail =
      cand === 'high' || cand === 'very_high'
        ? 'Both are high-energy'
        : cand === 'low'
          ? 'Both prefer a mellow pace'
          : 'Both have a similar energy level';
    return { contribution: 1, detail };
  }
  if (dist === 1) return { contribution: 0.4, detail: 'Energy levels are close' };
  return { contribution: -0.6, detail: 'Very different energy levels' };
}

function playStyleSignal(facts: CandidateFacts): SignalOutcome | null {
  const sub = facts.subject.playStyles;
  const cand = facts.candidate.playStyles;
  if (sub.length === 0 || cand.length === 0) return null;

  let affinity = 0;
  const frictionPairs: Array<[PlayStyle, PlayStyle]> = [];
  for (const a of sub) {
    for (const b of cand) {
      if (pairMatches(PLAY_STYLE_AFFINITY, a, b)) affinity += 1;
      if (pairMatches(PLAY_STYLE_FRICTION, a, b)) frictionPairs.push([a, b]);
    }
  }

  const plus = Math.min(1, affinity / Math.min(sub.length, cand.length));
  const minus = Math.min(1, frictionPairs.length * 0.7);
  const contribution = clamp(plus - minus, -1, 1);

  const conflicts = [
    ...new Set(
      frictionPairs.map(([a, b]) => `${humanise(a)} play and ${humanise(b)} play can be a rough mix`),
    ),
  ];

  const shared = sub.filter((s) => cand.includes(s));
  const detail =
    shared.length > 0
      ? `Both enjoy ${humanList(shared.map((s) => PLAY_STYLE_WORDS[s]))}`
      : affinity > 0
        ? 'Their play styles complement each other'
        : frictionPairs.length > 0
          ? 'Their play styles may clash'
          : 'Different play styles';

  return conflicts.length > 0 ? { contribution, detail, conflicts } : { contribution, detail };
}

function sizeSignal(facts: CandidateFacts): SignalOutcome | null {
  const cand = facts.candidate.size;
  // Owner-stated hard limits trump any distance-in-order arithmetic.
  if (facts.subject.goodWithLargeDogs === false && (cand === 'large' || cand === 'giant')) {
    return {
      contribution: -1,
      detail: 'Bigger than the sizes your dog does well with',
      conflicts: [`${candidateName(facts)} is larger than your preferred range`],
    };
  }
  if (facts.subject.goodWithSmallDogs === false && (cand === 'toy' || cand === 'small')) {
    return {
      contribution: -1,
      detail: 'Smaller than the sizes your dog does well with',
      conflicts: [`${candidateName(facts)} is smaller than your preferred range`],
    };
  }
  const si = orderIndex(SIZE_ORDER, facts.subject.size);
  const ci = orderIndex(SIZE_ORDER, cand);
  if (si < 0 || ci < 0) return null;
  const dist = Math.abs(si - ci);
  if (dist === 0) return { contribution: 1, detail: 'About the same size' };
  if (dist === 1) return { contribution: 0.6, detail: 'Similar sizes' };
  if (dist === 2) return { contribution: -0.3, detail: 'Quite different sizes' };
  return { contribution: -0.6, detail: 'Very different sizes' };
}

function ageSignal(facts: CandidateFacts): SignalOutcome | null {
  const a = facts.subject.ageYears;
  const b = facts.candidate.ageYears;
  if (a === null || b === null) return null;
  const delta = Math.abs(a - b);
  if (delta <= 1) return { contribution: 1, detail: 'Very close in age' };
  if (delta <= 2) return { contribution: 0.5, detail: 'Within a couple of years in age' };
  if (delta <= 4) return { contribution: 0, detail: 'A few years apart in age' };
  return { contribution: -0.4, detail: 'A big age gap' };
}

function temperamentSignal(facts: CandidateFacts, parsed: ParsedIntent): SignalOutcome | null {
  const cand = facts.candidate.temperament;
  const requested = parsed.temperament;
  let base: SignalOutcome | null = null;

  if (requested.length > 0 && cand.length > 0) {
    const matched = requested.filter((t) => cand.includes(t));
    base =
      matched.length > 0
        ? {
            contribution: matched.length / requested.length,
            detail: `Matches what you asked for: ${humanList(matched.map(humanise))}`,
          }
        : {
            contribution: -0.2,
            detail: `Not described as ${humanList(requested.map(humanise))}`,
          };
  } else if (cand.length > 0 && facts.subject.temperament.length > 0) {
    const shared = facts.subject.temperament.filter((t) => cand.includes(t));
    base =
      shared.length > 0
        ? {
            contribution: Math.min(1, shared.length / Math.min(cand.length, facts.subject.temperament.length)),
            detail: `Both are ${humanList(shared.map(humanise))}`,
          }
        : { contribution: 0, detail: 'Different temperaments' };
  }

  // A nervous dog and a very social dog is a manageable but real mismatch.
  if (cand.includes('nervous') && facts.subject.sociability === 'very_social') {
    const conflict = `${candidateName(facts)} is nervous and ${subjectName(facts)} is very social — introduce them gently`;
    if (base) {
      return {
        contribution: clamp(base.contribution - 0.4, -1, 1),
        detail: base.detail,
        conflicts: [...(base.conflicts ?? []), conflict],
      };
    }
    return {
      contribution: -0.4,
      detail: 'A nervous dog with a very social one needs a careful introduction',
      conflicts: [conflict],
    };
  }

  return base;
}

function scheduleSignal(facts: CandidateFacts, parsed: ParsedIntent): SignalOutcome | null {
  const subSlots = facts.subject.availability;
  const candSlots = facts.candidate.availability;
  const conflicts: string[] = [];
  let requestedSlotMissing = false;

  // "free Saturday morning?" — a soft requirement: flag its absence, don't drop
  // the candidate. Only check when the candidate has actually shared a schedule.
  const wanted = parsed.availability;
  if (wanted && (wanted.weekday || wanted.daypart) && candSlots.length > 0) {
    const has = candSlots.some(
      (s) => (!wanted.weekday || s.weekday === wanted.weekday) && (!wanted.daypart || s.daypart === wanted.daypart),
    );
    if (!has) {
      conflicts.push(`Not usually free ${slotLabel(wanted)}`);
      requestedSlotMissing = true;
    }
  }

  if (subSlots.length === 0 || candSlots.length === 0) {
    // No data on one side is an unknown, not a clash — unless a requested slot
    // is already known to be missing.
    return conflicts.length > 0
      ? { contribution: -0.3, detail: conflicts[0] ?? 'Schedules may not overlap', conflicts }
      : null;
  }

  const slotKey = (s: AvailabilitySlot): string => `${s.weekday}|${s.daypart}`;
  const candKeys = new Set(candSlots.map(slotKey));
  const shared = new Set(subSlots.map(slotKey).filter((k) => candKeys.has(k))).size;

  let contribution: number;
  let detail: string;
  if (shared === 0) {
    contribution = -0.3;
    detail = 'Schedules may not overlap';
    conflicts.push('Schedules may not overlap');
  } else if (shared === 1) {
    contribution = 0.5;
    detail = 'One shared free time slot';
  } else {
    contribution = 1;
    detail = `Free at ${shared} of the same times each week`;
  }
  if (requestedSlotMissing) contribution = clamp(contribution - 0.4, -1, 1);

  return conflicts.length > 0 ? { contribution, detail, conflicts } : { contribution, detail };
}

function sociabilitySignal(facts: CandidateFacts): SignalOutcome | null {
  const si = orderIndex(SOCIABILITY_ORDER, facts.subject.sociability);
  const ci = orderIndex(SOCIABILITY_ORDER, facts.candidate.sociability);
  if (si < 0 || ci < 0) return null;
  const dist = Math.abs(si - ci);
  if (dist === 0) return { contribution: 1, detail: 'Similarly social' };
  if (dist === 1) return { contribution: 0.5, detail: 'Close in sociability' };
  if (dist === 2) return { contribution: 0, detail: 'Somewhat different social styles' };
  return { contribution: -0.5, detail: 'Very different social styles' };
}

function interestsSignal(facts: CandidateFacts): SignalOutcome | null {
  const sub = facts.subject.interests;
  const cand = facts.candidate.interests;
  if (sub.length === 0 || cand.length === 0) return null;
  const shared = sub.filter((i) => cand.includes(i));
  const union = new Set([...sub, ...cand]).size;
  const jaccard = union === 0 ? 0 : shared.length / union;
  if (shared.length === 0) return { contribution: 0, detail: 'No overlapping interests yet' };
  return {
    contribution: clamp(jaccard, 0, 1),
    detail: `Both enjoy ${humanList(shared.map((i) => INTEREST_WORDS[i] ?? humanise(i)))}`,
  };
}

function historySignal(facts: CandidateFacts): SignalOutcome | null {
  const h = facts.history;
  if (!h || h.meetCount === 0) return null;
  if (h.wantsAgain === true) {
    return { contribution: 1, detail: 'Their dogs have met before and it went well' };
  }
  if (h.rapport !== null) {
    return {
      contribution: clamp(h.rapport, -1, 1),
      detail: h.rapport >= 0 ? 'Their dogs have met before' : 'A previous meeting did not go smoothly',
    };
  }
  return { contribution: 0.3, detail: 'Their dogs have met before' };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * scoreCandidate
 * ───────────────────────────────────────────────────────────────────────────*/

export function scoreCandidate(facts: CandidateFacts, parsed: ParsedIntent): ScoreResult {
  // Fixed evaluation order keeps signal arrays byte-for-byte stable.
  const builders: Array<[SignalKey, SignalOutcome | null]> = [
    ['activity_similarity', activitySignal(facts, parsed)],
    ['play_style', playStyleSignal(facts)],
    ['size_compat', sizeSignal(facts)],
    ['age_similarity', ageSignal(facts)],
    ['temperament', temperamentSignal(facts, parsed)],
    ['schedule_overlap', scheduleSignal(facts, parsed)],
    ['sociability', sociabilitySignal(facts)],
    ['shared_interests', interestsSignal(facts)],
    ['history', historySignal(facts)],
  ];

  const signals: MatchSignalDto[] = [];
  const conflicts: string[] = [];
  let weightedSum = 0;

  for (const [key, outcome] of builders) {
    if (!outcome) continue; // missing data contributes exactly nothing
    const contribution = clamp(outcome.contribution, -1, 1);
    const weight = WEIGHTS[key];
    weightedSum += weight * contribution;
    signals.push({ key, label: LABELS[key], contribution, weight, detail: outcome.detail });
    for (const c of outcome.conflicts ?? []) {
      if (!conflicts.includes(c)) conflicts.push(c);
    }
  }

  const score = Math.round(clamp(50 + 50 * weightedSum, 0, 100));
  return { score, signals, conflicts };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Mating readiness — a data-completeness meter, deliberately NOT a
 * compatibility score. See the disclaimer attached by the engine.
 * ───────────────────────────────────────────────────────────────────────────*/

export interface BreedingFacts {
  reproductiveStatus: string | null;
  registrationNumber: string | null;
  pedigree: string | null;
  geneticTests: string[];
  healthScreenings: string[];
  vetClearance: string | null;
}

export interface MatingProfileFacts {
  breed: string | null;
  ageYears: number | null;
  sex: DogSex;
}

export function matingReadiness(
  breeding: BreedingFacts | null | undefined,
  profile: MatingProfileFacts,
): { completeness: number; gaps: string[] } {
  const status = breeding?.reproductiveStatus ?? null;

  // Profile basics are prerequisites (shown as warnings) but don't count toward
  // breeding-record completeness — owners can't earn a high score just by having
  // a name and breed on file; they need actual health and registration records.
  const prerequisites: Array<{ ok: boolean; gap: string }> = [
    { ok: profile.breed !== null && profile.breed.trim() !== '', gap: 'No exact breed provided' },
    { ok: profile.ageYears !== null, gap: 'Age not provided' },
    { ok: profile.sex === 'male' || profile.sex === 'female', gap: 'Sex not specified' },
  ];

  const records: Array<{ ok: boolean; gap: string }> = [
    {
      ok: status === 'intact',
      gap: status && status !== 'unknown' ? 'Not recorded as intact' : 'No reproductive status provided',
    },
    { ok: !!breeding?.registrationNumber, gap: 'No registration number provided' },
    { ok: !!breeding?.pedigree, gap: 'No pedigree information provided' },
    { ok: (breeding?.geneticTests.length ?? 0) > 0, gap: 'No genetic test results provided' },
    { ok: (breeding?.healthScreenings.length ?? 0) > 0, gap: 'No health screening results provided' },
    { ok: !!breeding?.vetClearance, gap: 'No vet clearance provided' },
  ];

  const provided = records.filter((c) => c.ok).length;
  const gaps = [
    ...prerequisites.filter((c) => !c.ok).map((c) => c.gap),
    ...records.filter((c) => !c.ok).map((c) => c.gap),
  ];
  return {
    completeness: provided / records.length,
    gaps,
  };
}
