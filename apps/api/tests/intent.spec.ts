import { describe, expect, it } from 'vitest';
import { parseIntentHeuristic } from '../src/ai/heuristic/intent.js';
import type { IntentContext } from '../src/ai/types.js';

const ctx: IntentContext = {
  dogName: 'Rex',
  dogBreed: 'Golden Retriever',
  dogAgeYears: 3,
  defaultRadiusKm: 15,
  city: 'Tel Aviv',
  // Fixed date so "this weekend" and "tomorrow" are reproducible.
  now: '2026-08-12T09:00:00.000Z', // a Wednesday
};

const parse = (utterance: string) => parseIntentHeuristic(utterance, ctx);

describe('intent parsing — the utterances from the product spec', () => {
  it('routes a walk request and reads "nearby" and "this weekend"', () => {
    const r = parse('Find my dog some friendly dogs nearby for a walk this weekend.');
    expect(r.intent).toBe('walk');
    expect(r.radiusKm).toBe(10);
    expect(r.availability?.weekday).toBe('sat');
    expect(r.availability?.label).toBe('this weekend');
  });

  it('treats mating as its own intent and requires an intact candidate', () => {
    const r = parse('I want to find a suitable mating match for my Golden Retriever.');
    expect(r.intent).toBe('mating');
    expect(r.breedPreference).toBe('Golden Retriever');
    expect(r.reproductiveStatus).toBe('intact');
  });

  it('derives an age band from the subject dog for "around my dog\'s age"', () => {
    const r = parse("Find dogs around my dog's age that like energetic play.");
    expect(r.minAgeYears).toBeCloseTo(1.5, 5);
    expect(r.maxAgeYears).toBeCloseTo(4.5, 5);
    expect(r.temperament).toContain('energetic');
  });

  it('separates a calm walk from a running partner', () => {
    const calm = parse('Find a calm dog for a walk.');
    const running = parse('Find a dog that can keep up with him running.');

    expect(calm.intent).toBe('walk');
    expect(calm.temperament).toContain('calm');

    expect(running.intent).toBe('running');
    expect(running.activityLevel).toBe('high');
  });

  it('reads radius in kilometres, kilometers and miles', () => {
    expect(parse('Only find dogs within 15 kilometres.').radiusKm).toBe(15);
    expect(parse('Only find dogs within 15 kilometers.').radiusKm).toBe(15);
    expect(parse('Show me dogs closer than 5 km.').radiusKm).toBe(5);
    expect(parse('Dogs within 2 miles please.').radiusKm).toBeCloseTo(3.2, 1);
  });

  it('respects negation instead of matching the bare keyword', () => {
    // "not too energetic" must not register as wanting an energetic dog.
    expect(parse('Something calm, not too energetic please.').temperament).not.toContain('energetic');
  });

  it('parses age bounds', () => {
    expect(parse('Dogs under 3 years old.').maxAgeYears).toBe(3);
    expect(parse('Dogs older than 5.').minAgeYears).toBe(5);
    expect(parse('Between 2 and 5 years.')).toMatchObject({ minAgeYears: 2, maxAgeYears: 5 });
    expect(parse('Looking for puppies.').maxAgeYears).toBe(1.5);
  });

  it('reads sex and size preferences', () => {
    expect(parse('Looking for a female dog.').sexes).toContain('female');
    expect(parse('Only small dogs please.').sizes).toContain('small');
  });

  it('is deterministic — the same utterance always parses identically', () => {
    const a = parse('Find my dog a calm walking buddy within 5 km this Saturday morning.');
    const b = parse('Find my dog a calm walking buddy within 5 km this Saturday morning.');
    expect(a).toEqual(b);
  });
});
