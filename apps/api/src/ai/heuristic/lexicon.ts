import {
  ACTIVITY_LEVELS,
  BREEDS,
  DAYPARTS,
  DOG_SIZES,
  INTERESTS,
  PLAY_STYLES,
  SOCIABILITY,
  TEMPERAMENT_TRAITS,
  WEEKDAYS,
  type ActivityLevel,
  type Daypart,
  type DogSize,
  type Interest,
  type PlayStyle,
  type Sociability,
  type TemperamentTrait,
  type Weekday,
} from '@doggystyle/shared';

/**
 * The vocabulary that powers the offline (heuristic) AI provider.
 *
 * This is deliberately explicit rather than learned: it is inspectable,
 * deterministic, testable, and costs nothing to run. See ADR 0007.
 */

export type Phrase = { patterns: string[] };

function build<T extends string>(map: Record<T, string[]>): Array<{ value: T; patterns: string[] }> {
  return (Object.entries(map) as [T, string[]][]).map(([value, patterns]) => ({ value, patterns }));
}

export const TEMPERAMENT_LEXICON = build<TemperamentTrait>({
  calm: ['calm', 'relaxed', 'chill', 'chilled', 'mellow', 'laid back', 'laid-back', 'easygoing', 'placid', 'quiet'],
  energetic: ['energetic', 'high energy', 'high-energy', 'bouncy', 'lively', 'zoomies', 'full of beans', 'hyper'],
  playful: ['playful', 'fun', 'loves to play', 'play', 'goofball', 'silly'],
  gentle: ['gentle', 'soft', 'sweet', 'tender', 'kind'],
  confident: ['confident', 'bold', 'self assured', 'self-assured', 'fearless'],
  nervous: ['nervous', 'anxious', 'shy around', 'timid', 'skittish', 'reactive', 'wary'],
  independent: ['independent', 'aloof', 'does his own thing', 'does her own thing', 'self sufficient'],
  affectionate: ['affectionate', 'cuddly', 'loving', 'snuggly', 'velcro', 'clingy'],
  curious: ['curious', 'inquisitive', 'nosy', 'explorer', 'investigates'],
  protective: ['protective', 'guard', 'watchful', 'alert to strangers'],
  goofy: ['goofy', 'clown', 'derpy', 'silly billy'],
  focused: ['focused', 'attentive', 'trainable', 'obedient', 'switched on'],
  vocal: ['vocal', 'barky', 'talkative', 'howls', 'yappy'],
  patient: ['patient', 'tolerant', 'good tempered', 'good-tempered'],
});

export const ACTIVITY_LEXICON = build<ActivityLevel>({
  low: ['low energy', 'lazy', 'couch', 'slow', 'gentle stroll', 'short walks', 'sedentary', 'senior pace'],
  moderate: ['moderate', 'medium energy', 'average', 'normal walks', 'medium-energy', 'medium energy'],
  high: ['active', 'high energy', 'energetic', 'long walks', 'sporty', 'athletic'],
  very_high: ['very active', 'very high energy', 'tireless', 'endless energy', 'marathon', 'never tires', 'running partner'],
});

export const SOCIABILITY_LEXICON = build<Sociability>({
  shy: ['shy', 'timid', 'nervous with dogs', 'reserved', 'keeps to himself', 'keeps to herself'],
  selective: ['selective', 'picky', 'particular about', 'choosy', 'some dogs', 'not all dogs'],
  friendly: ['friendly', 'sociable', 'gets on with', 'good with dogs', 'social'],
  very_social: ['very social', 'loves every dog', 'loves everyone', 'social butterfly', 'never met a stranger'],
});

export const PLAY_STYLE_LEXICON = build<PlayStyle>({
  gentle: ['gentle play', 'soft play', 'careful play', 'gentle'],
  chase: ['chase', 'chasing', 'zoomies', 'racing', 'tag'],
  wrestle: ['wrestle', 'wrestling', 'rough and tumble', 'rough play', 'body slam'],
  fetch: ['fetch', 'ball', 'frisbee', 'retrieve', 'throw'],
  tug: ['tug', 'tug of war', 'rope'],
  parallel_walk: ['parallel walk', 'walk alongside', 'walking buddy', 'walk together', 'strolls'],
  sniff_explore: ['sniff', 'sniffing', 'scent', 'explore', 'snuffle', 'nose work'],
  water: ['swim', 'swimming', 'water', 'beach', 'lake', 'sea', 'river'],
});

export const INTEREST_LEXICON = build<Interest>({
  long_walks: ['long walk', 'long walks', 'rambles', 'hour walk'],
  hiking: ['hike', 'hiking', 'trail', 'trails', 'mountain'],
  running: ['run', 'running', 'jog', 'jogging', 'canicross'],
  beach: ['beach', 'seaside', 'sand', 'shore'],
  swimming: ['swim', 'swimming', 'lake', 'pool'],
  dog_park: ['dog park', 'park', 'off leash', 'off-leash'],
  fetch: ['fetch', 'ball', 'frisbee'],
  agility: ['agility', 'obstacle', 'weave poles'],
  training: ['training', 'tricks', 'obedience', 'classes'],
  cafe_sitting: ['cafe', 'coffee', 'brunch', 'patio'],
  car_trips: ['road trip', 'car ride', 'car trips'],
  snuffle_games: ['snuffle', 'puzzle', 'scent game', 'nose games'],
});

export const SIZE_LEXICON = build<DogSize>({
  toy: ['toy', 'tiny', 'teacup'],
  small: ['small', 'little', 'petite'],
  medium: ['medium', 'mid size', 'mid-size', 'medium sized', 'medium-sized'],
  large: ['large', 'big'],
  giant: ['giant', 'huge', 'enormous', 'massive'],
});

export const WEEKDAY_LEXICON = build<Weekday>({
  sun: ['sunday', 'sundays', 'sun'],
  mon: ['monday', 'mondays', 'mon'],
  tue: ['tuesday', 'tuesdays', 'tue', 'tues'],
  wed: ['wednesday', 'wednesdays', 'wed'],
  thu: ['thursday', 'thursdays', 'thu', 'thurs'],
  fri: ['friday', 'fridays', 'fri'],
  sat: ['saturday', 'saturdays', 'sat'],
});

export const DAYPART_LEXICON = build<Daypart>({
  early_morning: ['early morning', 'dawn', 'sunrise', 'first thing', 'before work'],
  morning: ['morning', 'mornings', 'am'],
  midday: ['midday', 'noon', 'lunchtime', 'lunch'],
  afternoon: ['afternoon', 'afternoons'],
  evening: ['evening', 'evenings', 'after work', 'sunset'],
  night: ['night', 'nights', 'late'],
});

/** Words that signal an explicitly mating-oriented request. */
export const MATING_TERMS = [
  'mating',
  'mate',
  'stud',
  'breed with',
  'breeding',
  'litter',
  'puppies with',
  'sire',
  'dam',
  'in season',
  'in heat',
];

export const INTENT_TERMS = {
  running: ['running partner', 'keep up with', 'run with', 'jogging partner', 'canicross', 'go running', 'runs'],
  walk: ['walking buddy', 'walk', 'walks', 'stroll', 'walking partner', 'go for a walk'],
  playdate: ['playdate', 'play date', 'play with', 'playmate', 'play buddy', 'romp'],
  training: ['training buddy', 'training partner', 'practice', 'classes together'],
  social: ['meet owners', 'owners with similar', 'meet people', 'dog people', 'community', 'similar dogs'],
} as const;

export const NEGATION_TERMS = ['not', "n't", 'never', 'no ', 'avoid', 'without', 'except', 'rather not', 'dislikes'];

export const BREED_PATTERNS: Array<{ name: string; patterns: string[] }> = BREEDS.map((b) => ({
  name: b.name,
  patterns: [b.name.toLowerCase(), ...(b.aliases ?? []).map((a) => a.toLowerCase())],
}));

/* ── Matching helpers ─────────────────────────────────────────────────────── */

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Find every lexicon value whose patterns appear in the text, skipping negated hits. */
export function matchLexicon<T extends string>(
  text: string,
  lexicon: Array<{ value: T; patterns: string[] }>,
  opts: { respectNegation?: boolean } = {},
): T[] {
  const haystack = normalise(text);
  const found: T[] = [];
  for (const entry of lexicon) {
    for (const pattern of entry.patterns) {
      const idx = haystack.indexOf(pattern);
      if (idx === -1) continue;
      if (opts.respectNegation && isNegated(haystack, idx)) continue;
      if (!found.includes(entry.value)) found.push(entry.value);
      break;
    }
  }
  return found;
}

/** True when a negation word appears within the preceding ~24 characters. */
export function isNegated(haystack: string, index: number): boolean {
  const window = haystack.slice(Math.max(0, index - 24), index);
  return NEGATION_TERMS.some((n) => window.includes(n));
}

export function containsAny(text: string, terms: readonly string[]): boolean {
  const haystack = normalise(text);
  return terms.some((t) => haystack.includes(t));
}

export const ALL_ACTIVITY_LEVELS = ACTIVITY_LEVELS;
export const ALL_SIZES = DOG_SIZES;
export const ALL_TEMPERAMENTS = TEMPERAMENT_TRAITS;
export const ALL_PLAY_STYLES = PLAY_STYLES;
export const ALL_INTERESTS = INTERESTS;
export const ALL_SOCIABILITY = SOCIABILITY;
export const ALL_WEEKDAYS = WEEKDAYS;
export const ALL_DAYPARTS = DAYPARTS;
