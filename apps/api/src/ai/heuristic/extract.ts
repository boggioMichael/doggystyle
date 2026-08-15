import {
  ACTIVITY_ORDER,
  BREEDS,
  isSensitiveAttributeKey,
  type ActivityLevel,
  type DogSex,
  type DogSize,
  type Interest,
  type PlayStyle,
  type Sociability,
  type TemperamentTrait,
} from '@doggystyle/shared';
import {
  profileExtractionSchema,
  type ProfileExtraction,
  type ProfileExtractionInput,
} from '../types.js';
import {
  ACTIVITY_LEXICON,
  BREED_PATTERNS,
  INTEREST_LEXICON,
  PLAY_STYLE_LEXICON,
  SIZE_LEXICON,
  SOCIABILITY_LEXICON,
  TEMPERAMENT_LEXICON,
  matchLexicon,
  normalise,
} from './lexicon.js';

/**
 * Deterministic profile extraction from imported captions, owner notes and
 * aggregate media statistics (never raw pixels — see ADR 0007).
 *
 * Everything inferred here is a *suggestion*: each derived field is mirrored in
 * `attributes[]` with a confidence and rationale so the owner can confirm or
 * reject it. Sensitive keys (health, breeding) are structurally impossible to
 * emit — they are filtered before validation as defence in depth.
 */

/* ── Confidence conventions (see task spec / ADR 0007) ───────────────────── */
const CONF_LEXICON = 0.75; // direct lexicon hit in a caption or note
const CONF_LEXICON_LIST = 0.7; // lexicon hit feeding a list field
const CONF_BREED_DEFAULT = 0.45; // derived from breed typicals, not observation
const CONF_MEDIA = 0.5; // derived from aggregate media statistics
const CONF_NAME = 0.6; // name guessing is inherently fuzzy

interface AttributeCandidate {
  key: string;
  value: unknown;
  confidence: number;
  rationale: string;
}

export function extractProfileHeuristic(input: ProfileExtractionInput): ProfileExtraction {
  const texts = [...input.captions, ...input.ownerNotes].filter((t) => t.trim().length > 0);
  const corpus = texts.join('\n');
  const corpusNorm = normalise(corpus);
  const attributes: AttributeCandidate[] = [];
  const known = input.knownAttributes ?? {};

  /* ── Name ───────────────────────────────────────────────────────────────── */
  let name = extractName(texts);
  if (name) {
    attributes.push({
      key: 'name',
      value: name,
      confidence: CONF_NAME,
      rationale: 'Name mentioned repeatedly or introduced in a caption.',
    });
  } else if (typeof known['name'] === 'string' && known['name'].trim()) {
    name = known['name'].trim();
  }

  /* ── Breed ──────────────────────────────────────────────────────────────── */
  const breedHit = findBreedInText(corpusNorm);
  let breed: string | null = breedHit?.name ?? null;
  if (breedHit) {
    attributes.push({
      key: 'breed',
      value: breedHit.name,
      confidence: Math.min(0.85, 0.7 + breedHit.pattern.length * 0.01),
      rationale: `Breed "${breedHit.pattern}" mentioned in captions or notes.`,
    });
  } else if (typeof known['breed'] === 'string' && known['breed'].trim()) {
    breed = known['breed'].trim();
  }
  const breedDefaults = breed ? BREEDS.find((b) => b.name.toLowerCase() === breed.toLowerCase()) : undefined;

  /* ── Age ────────────────────────────────────────────────────────────────── */
  const ageHit = extractAge(corpusNorm);
  let ageYears: number | null = ageHit?.value ?? null;
  if (ageHit) {
    attributes.push({ key: 'age_years', value: ageHit.value, confidence: ageHit.confidence, rationale: ageHit.rationale });
  } else if (typeof known['age_years'] === 'number' && known['age_years'] >= 0 && known['age_years'] <= 30) {
    ageYears = known['age_years'];
  }

  /* ── Sex ────────────────────────────────────────────────────────────────── */
  let sex = extractSex(corpusNorm);
  if (sex !== 'unknown') {
    attributes.push({
      key: 'sex',
      value: sex,
      confidence: CONF_LEXICON,
      rationale: sex === 'male' ? 'Referred to as he/him/boy in captions.' : 'Referred to as she/her/girl in captions.',
    });
  } else if (typeof known['sex'] === 'string' && (['male', 'female'] as string[]).includes(known['sex'])) {
    sex = known['sex'] as DogSex;
  }

  /* ── Size: breed default first, then explicit words ─────────────────────── */
  let size: DogSize | null = null;
  if (breedDefaults) {
    size = breedDefaults.size;
    attributes.push({
      key: 'size',
      value: size,
      confidence: CONF_BREED_DEFAULT,
      rationale: `Typical size for a ${breedDefaults.name}.`,
    });
  } else {
    const sizeHit = matchLexicon<DogSize>(corpusNorm, SIZE_LEXICON, { respectNegation: true })[0] ?? null;
    if (sizeHit) {
      size = sizeHit;
      attributes.push({ key: 'size', value: size, confidence: CONF_LEXICON, rationale: 'Size described in captions or notes.' });
    }
  }

  /* ── Activity level: lexicon → breed default, media motion bumps a level ── */
  const activity = extractActivity(corpusNorm, breedDefaults?.activity ?? null, input.mediaFeatures.motionRatio);
  const activityLevel = activity?.value ?? null;
  if (activity) {
    attributes.push({ key: 'activity_level', value: activity.value, confidence: activity.confidence, rationale: activity.rationale });
  }

  /* ── Sociability ────────────────────────────────────────────────────────── */
  const sociability = matchLexicon<Sociability>(corpusNorm, SOCIABILITY_LEXICON, { respectNegation: true })[0] ?? null;
  if (sociability) {
    attributes.push({
      key: 'sociability',
      value: sociability,
      confidence: CONF_LEXICON,
      rationale: 'Social behaviour described in captions or notes.',
    });
  }

  /* ── List fields from the lexicons (negation-aware) ─────────────────────── */
  const playStyles = matchLexicon<PlayStyle>(corpusNorm, PLAY_STYLE_LEXICON, { respectNegation: true });
  if (playStyles.length) {
    attributes.push({
      key: 'play_styles',
      value: playStyles,
      confidence: CONF_LEXICON_LIST,
      rationale: 'Play described in captions or notes.',
    });
  }

  const temperament = matchLexicon<TemperamentTrait>(corpusNorm, TEMPERAMENT_LEXICON, { respectNegation: true });
  if (temperament.length) {
    attributes.push({
      key: 'temperament',
      value: temperament,
      confidence: CONF_LEXICON_LIST,
      rationale: 'Personality words found in captions or notes.',
    });
  }

  const interests = matchLexicon<Interest>(corpusNorm, INTEREST_LEXICON, { respectNegation: true });
  if (interests.length) {
    attributes.push({
      key: 'interests',
      value: interests,
      confidence: CONF_LEXICON_LIST,
      rationale: 'Activities mentioned in captions or notes.',
    });
  }

  /* ── Bio: short template composed only from what we derived ─────────────── */
  const bio = composeBio({ name, breed, ageYears, sociability, temperament, interests, playStyles, activityLevel });
  if (bio) {
    attributes.push({ key: 'bio', value: bio, confidence: CONF_MEDIA, rationale: 'Composed from the derived traits above.' });
  }

  const extraction: ProfileExtraction = {
    name,
    breed,
    breedSecondary: null,
    ageYears,
    sex,
    size,
    activityLevel,
    sociability,
    playStyles,
    temperament,
    interests,
    bio,
    // Defence in depth: nothing above can produce a sensitive key, but a DB
    // CHECK constraint backs this filter up anyway (ADR 0006).
    attributes: attributes.filter((a) => !isSensitiveAttributeKey(a.key)),
  };

  return profileExtractionSchema.parse(extraction);
}

/* ── Name detection ───────────────────────────────────────────────────────── */

/** Capitalised words that are almost certainly not a dog's name. */
const NAME_STOPWORDS = new Set(
  [
    'the', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'his', 'her', 'their',
    'he', 'she', 'it', 'we', 'they', 'you', 'i', 'me', 'him', 'them', 'who', 'what',
    'when', 'where', 'why', 'how', 'and', 'but', 'not', 'with', 'without', 'just',
    'today', 'tomorrow', 'yesterday', 'tonight', 'morning', 'afternoon', 'evening',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december', 'weekend', 'summer', 'winter',
    'spring', 'autumn', 'fall', 'good', 'best', 'happy', 'birthday', 'love', 'loves',
    'dog', 'dogs', 'puppy', 'pup', 'doggo', 'park', 'beach', 'walk', 'walks', 'walkies',
    'instagram', 'photo', 'photos', 'new', 'big', 'little', 'so', 'such', 'very',
    'meet', 'meets', 'look', 'first', 'finally', 'another', 'every', 'always', 'never',
    'is', 'was', 'has', 'had', 'got', 'goes', 'went', 'said', 'says', 'here', 'there',
  ].map((w) => w.toLowerCase()),
);

/** Words that belong to breed names — "Retriever" is not a dog's name. */
const BREED_WORDS = new Set(BREED_PATTERNS.flatMap((b) => b.patterns.flatMap((p) => p.split(' '))));

function isPlausibleName(token: string): boolean {
  if (!/^[A-Z][a-z]{1,11}$/.test(token)) return false;
  const lower = token.toLowerCase();
  return !NAME_STOPWORDS.has(lower) && !BREED_WORDS.has(lower);
}

/** Explicit introduction patterns, run against the original (cased) text. */
const NAME_PATTERNS: RegExp[] = [
  /\bmy dog,?\s+(?:is\s+)?(?:called\s+|named\s+)?([A-Z][a-z]{1,11})\b/,
  /\bthis is\s+([A-Z][a-z]{1,11})\b/,
  /\b(?:meet|introducing|say hello to)\s+([A-Z][a-z]{1,11})\b/,
];

function extractName(texts: string[]): string | null {
  // 1) Explicit introduction phrasing beats everything.
  for (const text of texts) {
    for (const re of NAME_PATTERNS) {
      const m = text.match(re);
      if (m?.[1] && isPlausibleName(m[1])) return m[1];
    }
    // "Rex the Labrador" — the word after "the" must be a known breed pattern.
    const theBreed = text.match(/\b([A-Z][a-z]{1,11})\s+the\s+([A-Za-z][A-Za-z ]{2,30})/);
    if (theBreed?.[1] && theBreed[2] && isPlausibleName(theBreed[1])) {
      const rest = normalise(theBreed[2]);
      if (BREED_PATTERNS.some((b) => b.patterns.some((p) => rest.startsWith(p)))) return theBreed[1];
    }
  }

  // 2) Most frequent plausible capitalised token across all captions.
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of text.match(/[A-Za-z]+/g) ?? []) {
      if (!isPlausibleName(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  // Require repetition, and an outright winner — a tie means we are unsure.
  if (top && top[1] >= 2 && (!second || second[1] < top[1])) return top[0];
  return null;
}

/* ── Breed detection ──────────────────────────────────────────────────────── */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Longest word-bounded breed pattern wins ("italian greyhound" over "greyhound"). */
function findBreedInText(corpusNorm: string): { name: string; pattern: string } | null {
  let best: { name: string; pattern: string } | null = null;
  for (const b of BREED_PATTERNS) {
    for (const p of b.patterns) {
      if (best && p.length <= best.pattern.length) continue;
      const re = new RegExp(`\\b${escapeRegExp(p)}\\b`);
      if (re.test(corpusNorm)) best = { name: b.name, pattern: p };
    }
  }
  return best;
}

/* ── Age detection ────────────────────────────────────────────────────────── */

function extractAge(corpusNorm: string): { value: number; confidence: number; rationale: string } | null {
  // "3 year old", "3-year-old", "3 yrs old" — same exact forms as intent.ts.
  const years = corpusNorm.match(/\b(\d{1,2}(?:\.\d)?)[\s-]*(?:years?|yrs?|year)[\s-]*old\b/);
  if (years?.[1]) {
    const v = Number(years[1]);
    if (v >= 0 && v <= 30) return { value: v, confidence: CONF_LEXICON, rationale: `Described as ${v} years old.` };
  }

  // "10 months old", "10-month-old"
  const months = corpusNorm.match(/\b(\d{1,2})[\s-]*months?[\s-]*old\b/);
  if (months?.[1]) {
    const v = Math.round((Number(months[1]) / 12) * 10) / 10;
    if (v >= 0 && v <= 30) return { value: v, confidence: CONF_LEXICON, rationale: `Described as ${months[1]} months old.` };
  }

  // "just turned 4", "turning 2"
  const turned = corpusNorm.match(/\b(?:just )?turn(?:ed|ing|s)\s+(\d{1,2})\b/);
  if (turned?.[1]) {
    const v = Number(turned[1]);
    if (v >= 0 && v <= 30) return { value: v, confidence: CONF_LEXICON, rationale: `Recently turned ${v}.` };
  }

  if (/\bpupp(?:y|ies)\b/.test(corpusNorm)) {
    return { value: 0.8, confidence: CONF_MEDIA, rationale: 'Called a puppy in captions — assuming under a year.' };
  }

  return null;
}

/* ── Sex from pronouns ────────────────────────────────────────────────────── */

function extractSex(corpusNorm: string): DogSex {
  const male = (corpusNorm.match(/\b(?:he|him|his|boy|good boy)\b/g) ?? []).length;
  const female = (corpusNorm.match(/\b(?:she|her|hers|girl|good girl)\b/g) ?? []).length;
  // Precedence strictly by count; a tie means we do not guess.
  if (male > female) return 'male';
  if (female > male) return 'female';
  return 'unknown';
}

/* ── Activity level ───────────────────────────────────────────────────────── */

function extractActivity(
  corpusNorm: string,
  breedDefault: ActivityLevel | null,
  motionRatio: number,
): { value: ActivityLevel; confidence: number; rationale: string } | null {
  const lexHit = matchLexicon<ActivityLevel>(corpusNorm, ACTIVITY_LEXICON, { respectNegation: true })[0] ?? null;

  let base: ActivityLevel | null = lexHit;
  let confidence = CONF_LEXICON;
  let rationale = 'Energy level described in captions or notes.';

  if (!base && breedDefault) {
    base = breedDefault;
    confidence = CONF_BREED_DEFAULT;
    rationale = 'Typical energy level for the breed.';
  }

  // Lots of motion blur across the photo set suggests a livelier dog.
  if (motionRatio > 0.45) {
    if (base) {
      const idx = ACTIVITY_ORDER.indexOf(base);
      const bumped = ACTIVITY_ORDER[Math.min(ACTIVITY_ORDER.length - 1, idx + 1)];
      if (bumped && bumped !== base) {
        base = bumped;
        confidence = Math.max(confidence, CONF_MEDIA);
        rationale += ' Bumped one level: many action shots in the photo set.';
      }
    } else {
      base = 'high';
      confidence = CONF_MEDIA;
      rationale = 'Many action shots in the photo set suggest an active dog.';
    }
  }

  return base ? { value: base, confidence, rationale } : null;
}

/* ── Bio template ─────────────────────────────────────────────────────────── */

const SOCIABILITY_ADJECTIVE: Record<Sociability, string> = {
  shy: 'a little shy',
  selective: 'choosy about friends',
  friendly: 'friendly',
  very_social: 'super social',
};

const ACTIVITY_PHRASE: Record<ActivityLevel, string> = {
  low: 'relaxed strolls',
  moderate: 'medium-energy outdoor walks',
  high: 'long, energetic outings',
  very_high: 'non-stop adventures',
};

const humanise = (s: string): string => s.replaceAll('_', ' ');

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function composeBio(parts: {
  name: string | null;
  breed: string | null;
  ageYears: number | null;
  sociability: Sociability | null;
  temperament: TemperamentTrait[];
  interests: Interest[];
  playStyles: PlayStyle[];
  activityLevel: ActivityLevel | null;
}): string | null {
  const adjectives: string[] = [];
  if (parts.sociability) adjectives.push(SOCIABILITY_ADJECTIVE[parts.sociability]);
  for (const t of parts.temperament.slice(0, 2)) {
    const word = humanise(t);
    if (!adjectives.includes(word)) adjectives.push(word);
  }

  const enjoys: string[] = parts.interests.slice(0, 2).map(humanise);
  if (!enjoys.length && parts.playStyles[0]) enjoys.push(`${humanise(parts.playStyles[0])} play`);
  if (!enjoys.length && parts.activityLevel) enjoys.push(ACTIVITY_PHRASE[parts.activityLevel]);

  const sentences: string[] = [];
  if (adjectives.length && enjoys.length) {
    sentences.push(`${capitalise(joinList(adjectives))} and enjoys ${joinList(enjoys)}.`);
  } else if (adjectives.length) {
    sentences.push(`${capitalise(joinList(adjectives))}.`);
  } else if (enjoys.length) {
    sentences.push(`Enjoys ${joinList(enjoys)}.`);
  }

  if (parts.breed || parts.ageYears !== null) {
    const agePart = parts.ageYears !== null ? `${trimNumber(parts.ageYears)}-year-old ` : '';
    const breedPart = parts.breed ? parts.breed : 'dog';
    sentences.push(`A ${agePart}${breedPart} looking for new four-legged friends.`);
  }

  if (!sentences.length) return null;
  return sentences.slice(0, 2).join(' ');
}

const capitalise = (s: string): string => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);
const trimNumber = (n: number): string => (n % 1 === 0 ? String(n) : n.toFixed(1));
