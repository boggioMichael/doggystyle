import { describe, expect, it } from 'vitest';
import { parseIntentHeuristic } from '../src/ai/heuristic/intent.js';
import type { IntentContext, ParsedIntent } from '../src/ai/types.js';
import { matingReadiness, scoreCandidate, type CandidateFacts, type PartyFacts } from '../src/modules/matching/scoring.js';

const intentCtx: IntentContext = {
  dogName: 'Rex',
  dogBreed: null,
  dogAgeYears: 3,
  defaultRadiusKm: 15,
  city: 'Tel Aviv',
  now: '2026-08-12T09:00:00.000Z',
};

const plainPlaydate: ParsedIntent = parseIntentHeuristic('Find a playdate nearby', intentCtx);

function party(overrides: Partial<PartyFacts> = {}): PartyFacts {
  return {
    name: 'Dog',
    sex: 'male',
    size: 'medium',
    ageYears: 3,
    activityLevel: 'high',
    sociability: 'friendly',
    playStyles: ['fetch', 'chase'],
    temperament: ['playful'],
    interests: ['long_walks', 'fetch'],
    goodWithSmallDogs: true,
    goodWithLargeDogs: true,
    goodWithPuppies: true,
    goodWithKids: true,
    availability: [{ weekday: 'sat', daypart: 'morning' }],
    ...overrides,
  };
}

function facts(subject: Partial<PartyFacts>, candidate: Partial<PartyFacts>, distanceKm = 3): CandidateFacts {
  return {
    subject: party(subject),
    candidate: party(candidate),
    distanceKm,
    history: null,
  };
}

const signal = (result: ReturnType<typeof scoreCandidate>, key: string) =>
  result.signals.find((s) => s.key === key);

describe('match scoring — deterministic, explainable, bounded', () => {
  it('gives the same answer every time for the same facts', () => {
    const f = facts({}, {});
    expect(scoreCandidate(f, plainPlaydate)).toEqual(scoreCandidate(f, plainPlaydate));
  });

  it('stays within 0–100 across a wide sweep of combinations', () => {
    const activities = ['low', 'moderate', 'high', 'very_high'] as const;
    const sizes = ['toy', 'small', 'medium', 'large', 'giant'] as const;

    for (const sa of activities) {
      for (const ca of activities) {
        for (const ss of sizes) {
          for (const cs of sizes) {
            const { score } = scoreCandidate(
              facts({ activityLevel: sa, size: ss }, { activityLevel: ca, size: cs }),
              plainPlaydate,
            );
            expect(score).toBeGreaterThanOrEqual(0);
            expect(score).toBeLessThanOrEqual(100);
            expect(Number.isInteger(score)).toBe(true);
          }
        }
      }
    }
  });

  it('rates matched energy above a two-level mismatch', () => {
    const matched = scoreCandidate(facts({ activityLevel: 'high' }, { activityLevel: 'high' }), plainPlaydate);
    const mismatched = scoreCandidate(facts({ activityLevel: 'high' }, { activityLevel: 'low' }), plainPlaydate);

    expect(matched.score).toBeGreaterThan(mismatched.score);
    expect(signal(matched, 'activity_similarity')!.contribution).toBeGreaterThan(0);
    expect(signal(mismatched, 'activity_similarity')!.contribution).toBeLessThan(0);
  });

  it('flags a play-style clash as a conflict, not just a lower number', () => {
    const clash = scoreCandidate(
      facts({ playStyles: ['gentle'] }, { playStyles: ['wrestle'] }),
      plainPlaydate,
    );
    expect(clash.conflicts.length).toBeGreaterThan(0);
    expect(signal(clash, 'play_style')!.contribution).toBeLessThan(0);
  });

  it('honours an owner saying their dog is not good with large dogs', () => {
    const result = scoreCandidate(
      facts({ size: 'small', goodWithLargeDogs: false }, { size: 'giant' }),
      plainPlaydate,
    );
    expect(result.conflicts.join(' ').toLowerCase()).toMatch(/larg|big/);
    expect(signal(result, 'size_compat')!.contribution).toBeLessThan(0);
  });

  it('rewards a shared free slot and warns when there is none', () => {
    const overlapping = scoreCandidate(
      facts(
        { availability: [{ weekday: 'sat', daypart: 'morning' }] },
        { availability: [{ weekday: 'sat', daypart: 'morning' }] },
      ),
      plainPlaydate,
    );
    const disjoint = scoreCandidate(
      facts(
        { availability: [{ weekday: 'sat', daypart: 'morning' }] },
        { availability: [{ weekday: 'tue', daypart: 'night' }] },
      ),
      plainPlaydate,
    );

    expect(signal(overlapping, 'schedule_overlap')!.contribution).toBeGreaterThan(
      signal(disjoint, 'schedule_overlap')!.contribution,
    );
    expect(overlapping.score).toBeGreaterThan(disjoint.score);
  });

  it('lets a good shared history lift the score', () => {
    const base = facts({}, {});
    const withHistory: CandidateFacts = {
      ...base,
      history: { meetCount: 3, rapport: 0.9, wantsAgain: true },
    };
    expect(scoreCandidate(withHistory, plainPlaydate).score).toBeGreaterThan(
      scoreCandidate(base, plainPlaydate).score,
    );
  });

  it('contributes nothing at all for missing data rather than guessing', () => {
    const unknown = scoreCandidate(
      facts({ activityLevel: null }, { activityLevel: null }),
      plainPlaydate,
    );
    expect(signal(unknown, 'activity_similarity')).toBeUndefined();
  });

  it('gives every signal a human-readable detail for the explainer', () => {
    const result = scoreCandidate(facts({}, {}), plainPlaydate);
    expect(result.signals.length).toBeGreaterThan(0);
    for (const s of result.signals) {
      expect(s.detail.length).toBeGreaterThan(0);
      expect(s.label.length).toBeGreaterThan(0);
      expect(Math.abs(s.contribution)).toBeLessThanOrEqual(1);
    }
  });
});

describe('mating readiness — completeness, never a compatibility score', () => {
  const profile = { sex: 'female' as const, ageYears: 3, breed: 'Golden Retriever' };

  it('reports zero completeness and names the gaps when nothing is provided', () => {
    const { completeness, gaps } = matingReadiness(null, profile);
    expect(completeness).toBe(0);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.join(' ')).toMatch(/\w/);
  });

  it('increases as the owner supplies real records', () => {
    const partial = matingReadiness(
      { reproductiveStatus: 'intact', registrationNumber: 'IKC-1', pedigree: null, geneticTests: [], healthScreenings: [], vetClearance: null },
      profile,
    );
    const complete = matingReadiness(
      {
        reproductiveStatus: 'intact',
        registrationNumber: 'IKC-1',
        pedigree: 'documented',
        geneticTests: ['prcd-PRA: clear'],
        healthScreenings: ['Hips OFA Good'],
        vetClearance: 'cleared 2026',
      },
      profile,
    );

    expect(partial.completeness).toBeGreaterThan(0);
    expect(complete.completeness).toBeGreaterThan(partial.completeness);
    expect(complete.gaps.length).toBeLessThan(partial.gaps.length);
    expect(complete.completeness).toBeLessThanOrEqual(1);
  });
});
