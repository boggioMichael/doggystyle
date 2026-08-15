import type { DogSex, DogSize, MatchIntent, TemperamentTrait, Weekday } from '@doggystyle/shared';
import { parsedIntentSchema, type IntentContext, type ParsedIntent } from '../types.js';
import {
  ACTIVITY_LEXICON,
  BREED_PATTERNS,
  DAYPART_LEXICON,
  INTENT_TERMS,
  MATING_TERMS,
  SIZE_LEXICON,
  TEMPERAMENT_LEXICON,
  WEEKDAY_LEXICON,
  containsAny,
  matchLexicon,
  normalise,
} from './lexicon.js';

const WEEKDAY_ORDER: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Grammar + lexicon intent parser. Fully deterministic, so the same utterance
 * always produces the same search — which makes matching regressions testable.
 */
export function parseIntentHeuristic(utterance: string, context: IntentContext): ParsedIntent {
  const text = normalise(utterance);
  let signals = 0;

  /* ── Intent ─────────────────────────────────────────────────────────────── */
  let intent: MatchIntent = 'playdate';
  if (containsAny(text, MATING_TERMS)) {
    intent = 'mating';
    signals += 2;
  } else if (containsAny(text, INTENT_TERMS.running)) {
    intent = 'running';
    signals += 1;
  } else if (containsAny(text, INTENT_TERMS.training)) {
    intent = 'training';
    signals += 1;
  } else if (containsAny(text, INTENT_TERMS.playdate)) {
    intent = 'playdate';
    signals += 1;
  } else if (containsAny(text, INTENT_TERMS.walk)) {
    intent = 'walk';
    signals += 1;
  } else if (containsAny(text, INTENT_TERMS.social)) {
    intent = 'social';
    signals += 1;
  }

  /* ── Breed ──────────────────────────────────────────────────────────────── */
  let breedPreference: string | null = null;
  // Longest pattern first so "italian greyhound" wins over "greyhound".
  const breedHits = BREED_PATTERNS.flatMap((b) => b.patterns.map((p) => ({ name: b.name, p })))
    .filter((x) => text.includes(x.p))
    .sort((a, b) => b.p.length - a.p.length);
  if (breedHits[0] && breedHits[0].name !== 'Mixed Breed') {
    breedPreference = breedHits[0].name;
    signals += 1;
  }

  /* ── Temperament & activity ─────────────────────────────────────────────── */
  const temperament = matchLexicon<TemperamentTrait>(text, TEMPERAMENT_LEXICON, { respectNegation: true });
  if (temperament.length) signals += 1;

  let activityLevel = matchLexicon(text, ACTIVITY_LEXICON, { respectNegation: true })[0] ?? null;
  if (intent === 'running' && !activityLevel) activityLevel = 'high';
  if (activityLevel) signals += 1;

  /* ── Size ───────────────────────────────────────────────────────────────── */
  const sizes = matchLexicon<DogSize>(text, SIZE_LEXICON, { respectNegation: true });
  if (sizes.length) signals += 1;

  /* ── Sex ────────────────────────────────────────────────────────────────── */
  const sexes: DogSex[] = [];
  if (/\b(female|bitch|girl dog|she|her)\b/.test(text) && !/\bhis\b/.test(text)) sexes.push('female');
  if (/\b(male|stud|boy dog)\b/.test(text)) sexes.push('male');
  if (sexes.length) signals += 1;

  /* ── Age ────────────────────────────────────────────────────────────────── */
  const { minAgeYears, maxAgeYears, matched: ageMatched } = parseAge(text, context);
  if (ageMatched) signals += 1;

  /* ── Radius ─────────────────────────────────────────────────────────────── */
  const radiusKm = parseRadius(text);
  if (radiusKm !== null) signals += 1;

  /* ── Availability ───────────────────────────────────────────────────────── */
  const availability = parseAvailability(text, context);
  if (availability) signals += 1;

  /* ── Reproductive status (mating only) ──────────────────────────────────── */
  let reproductiveStatus: ParsedIntent['reproductiveStatus'] = null;
  if (intent === 'mating') {
    // For a mating search only intact dogs are viable candidates.
    reproductiveStatus = 'intact';
  } else if (/\b(neutered|spayed|fixed|desexed)\b/.test(text)) {
    reproductiveStatus = /\bspayed\b/.test(text) ? 'spayed' : 'neutered';
  }

  const parsed: ParsedIntent = {
    intent,
    breedPreference,
    temperament,
    activityLevel,
    sizes,
    sexes,
    minAgeYears,
    maxAgeYears,
    radiusKm,
    availability,
    reproductiveStatus,
    freeText: utterance.trim().slice(0, 500),
    confidence: Math.min(0.95, 0.35 + signals * 0.12),
  };

  return parsedIntentSchema.parse(parsed);
}

/* ── Sub-parsers ──────────────────────────────────────────────────────────── */

function parseAge(
  text: string,
  context: IntentContext,
): { minAgeYears: number | null; maxAgeYears: number | null; matched: boolean } {
  // "around my dog's age" / "similar age to mine"
  if (/\b(around|about|similar to|same as|close to)\b[^.]*\b(my dog'?s? age|his age|her age|mine)\b/.test(text) ||
      /\b(dogs? (around|about) (my dog'?s?|his|her) age)\b/.test(text)) {
    if (context.dogAgeYears !== null) {
      return {
        minAgeYears: Math.max(0, Math.round((context.dogAgeYears - 1.5) * 10) / 10),
        maxAgeYears: Math.round((context.dogAgeYears + 1.5) * 10) / 10,
        matched: true,
      };
    }
    return { minAgeYears: null, maxAgeYears: null, matched: false };
  }

  // "between 2 and 5", "2-5 years", "2 to 5 years old"
  const range = text.match(/\b(\d{1,2})\s*(?:-|–|to|and)\s*(\d{1,2})\s*(?:years?|yrs?|y\/o|year old)?\b/);
  if (range?.[1] && range[2]) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (a <= 30 && b <= 30 && a < b) return { minAgeYears: a, maxAgeYears: b, matched: true };
  }

  // "under 3", "younger than 4", "less than 2 years"
  const under = text.match(/\b(?:under|younger than|less than|below|up to|max(?:imum)?)\s*(\d{1,2})\b/);
  if (under?.[1]) return { minAgeYears: null, maxAgeYears: Number(under[1]), matched: true };

  // "over 5", "older than 3", "at least 2"
  const over = text.match(/\b(?:over|older than|more than|above|at least|min(?:imum)?)\s*(\d{1,2})\b/);
  if (over?.[1]) return { minAgeYears: Number(over[1]), maxAgeYears: null, matched: true };

  if (/\bpupp(y|ies)\b/.test(text)) return { minAgeYears: 0, maxAgeYears: 1.5, matched: true };
  if (/\b(senior|older dogs?|elderly)\b/.test(text)) return { minAgeYears: 8, maxAgeYears: null, matched: true };
  if (/\badolescent|teenager|young dogs?\b/.test(text)) return { minAgeYears: 0.5, maxAgeYears: 3, matched: true };

  // "a 3 year old", "3-year-old"
  const exact = text.match(/\b(\d{1,2})[\s-]*(?:years?|yrs?|year)[\s-]*old\b/);
  if (exact?.[1]) {
    const a = Number(exact[1]);
    return { minAgeYears: Math.max(0, a - 1), maxAgeYears: a + 1, matched: true };
  }

  return { minAgeYears: null, maxAgeYears: null, matched: false };
}

function parseRadius(text: string): number | null {
  // "within 15 km", "closer than 5 km", "less than 10km away", "under 3 miles"
  const km = text.match(/\b(?:within|inside|under|less than|closer than|max(?:imum)?|up to|no more than)\s*(\d{1,3}(?:\.\d)?)\s*(km|kilomet(?:er|re)s?)\b/);
  if (km?.[1]) return clampRadius(Number(km[1]));

  const miles = text.match(/\b(?:within|inside|under|less than|closer than|up to)\s*(\d{1,3}(?:\.\d)?)\s*(mi|miles?)\b/);
  if (miles?.[1]) return clampRadius(Number(miles[1]) * 1.60934);

  // "15 km radius", "10km away"
  const bare = text.match(/\b(\d{1,3}(?:\.\d)?)\s*(?:km|kilomet(?:er|re)s?)\b/);
  if (bare?.[1]) return clampRadius(Number(bare[1]));

  if (/\b(walking distance|very close|right nearby|around the corner)\b/.test(text)) return 2;
  if (/\b(nearby|near us|near me|close by|local|in my area|around here)\b/.test(text)) return 10;

  return null;
}

function clampRadius(km: number): number | null {
  if (!Number.isFinite(km) || km <= 0) return null;
  return Math.min(500, Math.max(0.5, Math.round(km * 10) / 10));
}

function parseAvailability(text: string, context: IntentContext): ParsedIntent['availability'] {
  const daypart = matchLexicon(text, DAYPART_LEXICON)[0] ?? null;
  const explicitDay = matchLexicon(text, WEEKDAY_LEXICON)[0] ?? null;

  const now = new Date(context.now);
  const todayIdx = Number.isNaN(now.getTime()) ? 0 : now.getDay();

  let weekday: Weekday | null = explicitDay;
  let label: string | null = null;

  if (/\bthis weekend\b|\bweekend\b/.test(text)) {
    weekday = weekday ?? 'sat';
    label = 'this weekend';
  } else if (/\btomorrow\b/.test(text)) {
    weekday = WEEKDAY_ORDER[(todayIdx + 1) % 7] ?? null;
    label = 'tomorrow';
  } else if (/\btoday\b|\btonight\b/.test(text)) {
    weekday = WEEKDAY_ORDER[todayIdx] ?? null;
    label = /\btonight\b/.test(text) ? 'tonight' : 'today';
  } else if (explicitDay) {
    label = explicitDay;
  } else if (/\bnext week\b/.test(text)) {
    label = 'next week';
  }

  if (!weekday && !daypart && !label) return null;

  if (!label) {
    label = [weekday, daypart].filter(Boolean).join(' ') || null;
  }

  return { weekday, daypart, label };
}
