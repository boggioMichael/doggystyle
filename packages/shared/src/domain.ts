/**
 * Shared domain vocabulary. Used by the API (validation, matching, AI) and the web app
 * (labels, pickers, chips). Keeping it here guarantees both sides agree on the enums.
 */

export const DOG_SEXES = ['male', 'female', 'unknown'] as const;
export type DogSex = (typeof DOG_SEXES)[number];

export const DOG_SIZES = ['toy', 'small', 'medium', 'large', 'giant'] as const;
export type DogSize = (typeof DOG_SIZES)[number];

/** Approximate weight bands, used to convert an inferred weight to a size bucket. */
export const SIZE_WEIGHT_BANDS_KG: Record<DogSize, [number, number]> = {
  toy: [0, 5],
  small: [5, 12],
  medium: [12, 25],
  large: [25, 40],
  giant: [40, 120],
};

export const SIZE_ORDER: DogSize[] = ['toy', 'small', 'medium', 'large', 'giant'];

export const ACTIVITY_LEVELS = ['low', 'moderate', 'high', 'very_high'] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];
export const ACTIVITY_ORDER: ActivityLevel[] = ['low', 'moderate', 'high', 'very_high'];

export const PLAY_STYLES = [
  'gentle',
  'chase',
  'wrestle',
  'fetch',
  'tug',
  'parallel_walk',
  'sniff_explore',
  'water',
] as const;
export type PlayStyle = (typeof PLAY_STYLES)[number];

/** Play styles that mesh well with each other (symmetric pairs). */
export const PLAY_STYLE_AFFINITY: ReadonlyArray<readonly [PlayStyle, PlayStyle]> = [
  ['chase', 'chase'],
  ['chase', 'fetch'],
  ['wrestle', 'wrestle'],
  ['wrestle', 'tug'],
  ['tug', 'tug'],
  ['fetch', 'fetch'],
  ['gentle', 'gentle'],
  ['gentle', 'parallel_walk'],
  ['gentle', 'sniff_explore'],
  ['parallel_walk', 'parallel_walk'],
  ['parallel_walk', 'sniff_explore'],
  ['sniff_explore', 'sniff_explore'],
  ['water', 'water'],
  ['water', 'fetch'],
];

/** Combinations that are commonly a poor experience for one of the dogs. */
export const PLAY_STYLE_FRICTION: ReadonlyArray<readonly [PlayStyle, PlayStyle]> = [
  ['gentle', 'wrestle'],
  ['gentle', 'chase'],
  ['gentle', 'tug'],
  ['parallel_walk', 'wrestle'],
  ['sniff_explore', 'wrestle'],
];

export const SOCIABILITY = ['shy', 'selective', 'friendly', 'very_social'] as const;
export type Sociability = (typeof SOCIABILITY)[number];
export const SOCIABILITY_ORDER: Sociability[] = ['shy', 'selective', 'friendly', 'very_social'];

export const TEMPERAMENT_TRAITS = [
  'calm',
  'energetic',
  'playful',
  'gentle',
  'confident',
  'nervous',
  'independent',
  'affectionate',
  'curious',
  'protective',
  'goofy',
  'focused',
  'vocal',
  'patient',
] as const;
export type TemperamentTrait = (typeof TEMPERAMENT_TRAITS)[number];

export const INTERESTS = [
  'long_walks',
  'hiking',
  'running',
  'beach',
  'swimming',
  'dog_park',
  'fetch',
  'agility',
  'training',
  'cafe_sitting',
  'car_trips',
  'snuffle_games',
] as const;
export type Interest = (typeof INTERESTS)[number];

/** What the owner wants out of a match. `mating` is deliberately its own track. */
export const MATCH_INTENTS = ['playdate', 'walk', 'running', 'social', 'training', 'mating'] as const;
export type MatchIntent = (typeof MATCH_INTENTS)[number];

export const MATCH_INTENT_LABELS: Record<MatchIntent, string> = {
  playdate: 'Playdate',
  walk: 'Walk together',
  running: 'Running partner',
  social: 'Meet owners',
  training: 'Training buddy',
  mating: 'Mating match',
};

export const REPRODUCTIVE_STATUSES = ['intact', 'neutered', 'spayed', 'unknown'] as const;
export type ReproductiveStatus = (typeof REPRODUCTIVE_STATUSES)[number];

export const ATTRIBUTE_SOURCES = [
  'vision_model',
  'text_model',
  'social_import',
  'user',
  'verified_document',
  'system_default',
] as const;
export type AttributeSource = (typeof ATTRIBUTE_SOURCES)[number];

export const TRUSTED_ATTRIBUTE_SOURCES: AttributeSource[] = ['user', 'verified_document'];

/**
 * Attributes that MUST NOT be inferred by a model. Enforced in the service layer *and*
 * by a database CHECK constraint. See ADR 0006.
 */
export const SENSITIVE_ATTRIBUTE_KEYS = [
  'reproductive_status',
  'health_notes',
  'vaccination_status',
  'genetic_tests',
  'health_screenings',
  'pedigree',
  'registration_number',
  'litters_whelped',
  'last_season_date',
  'vet_clearance',
] as const;
export type SensitiveAttributeKey = (typeof SENSITIVE_ATTRIBUTE_KEYS)[number];

export const INFERABLE_ATTRIBUTE_KEYS = [
  'name',
  'breed',
  'breed_secondary',
  'age_years',
  'sex',
  'size',
  'weight_kg',
  'activity_level',
  'sociability',
  'play_styles',
  'temperament',
  'interests',
  'bio',
  'good_with_small_dogs',
  'good_with_large_dogs',
  'good_with_puppies',
  'good_with_kids',
] as const;
export type InferableAttributeKey = (typeof INFERABLE_ATTRIBUTE_KEYS)[number];

export type AttributeKey = InferableAttributeKey | SensitiveAttributeKey;

export function isSensitiveAttributeKey(key: string): key is SensitiveAttributeKey {
  return (SENSITIVE_ATTRIBUTE_KEYS as readonly string[]).includes(key);
}

/** Location precision the owner may choose. `exact` is never returned to peers. */
export const LOCATION_PRECISIONS = ['city', 'neighbourhood', 'exact'] as const;
export type LocationPrecision = (typeof LOCATION_PRECISIONS)[number];

export const PROFILE_VISIBILITY = ['public', 'matches_only', 'hidden'] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITY)[number];

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const DAYPARTS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening', 'night'] as const;
export type Daypart = (typeof DAYPARTS)[number];

export const DAYPART_LABELS: Record<Daypart, string> = {
  early_morning: 'Early morning',
  morning: 'Morning',
  midday: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
};

export const MEETUP_STATUSES = ['proposed', 'accepted', 'declined', 'cancelled', 'completed'] as const;
export type MeetupStatus = (typeof MEETUP_STATUSES)[number];

export const MATCH_REQUEST_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn', 'expired'] as const;
export type MatchRequestStatus = (typeof MATCH_REQUEST_STATUSES)[number];

export const SOCIAL_PROVIDER_IDS = ['demo', 'upload', 'archive', 'instagram', 'google_photos'] as const;
export type SocialProviderId = (typeof SOCIAL_PROVIDER_IDS)[number];

export const REPORT_REASONS = [
  'harassment',
  'inappropriate_content',
  'spam',
  'fake_profile',
  'animal_welfare',
  'no_show',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment or abuse',
  inappropriate_content: 'Inappropriate content',
  spam: 'Spam or scam',
  fake_profile: 'Fake profile',
  animal_welfare: 'Animal welfare concern',
  no_show: 'Did not show up to a meetup',
  other: 'Something else',
};

/** Minimum age for an account holder. See docs/THREAT_MODEL.md §R2. */
export const MINIMUM_ACCOUNT_AGE_YEARS = 18;

export const BREEDS: ReadonlyArray<{
  name: string;
  size: DogSize;
  activity: ActivityLevel;
  aliases?: string[];
}> = [
  { name: 'Labrador Retriever', size: 'large', activity: 'high', aliases: ['labrador', 'lab'] },
  { name: 'Golden Retriever', size: 'large', activity: 'high', aliases: ['golden', 'goldie'] },
  { name: 'Border Collie', size: 'medium', activity: 'very_high', aliases: ['collie'] },
  { name: 'German Shepherd', size: 'large', activity: 'high', aliases: ['gsd', 'alsatian'] },
  { name: 'Poodle', size: 'medium', activity: 'moderate', aliases: ['standard poodle'] },
  { name: 'Cockapoo', size: 'small', activity: 'moderate', aliases: [] },
  { name: 'Labradoodle', size: 'large', activity: 'high', aliases: ['doodle'] },
  { name: 'French Bulldog', size: 'small', activity: 'low', aliases: ['frenchie'] },
  { name: 'Bulldog', size: 'medium', activity: 'low', aliases: ['english bulldog'] },
  { name: 'Beagle', size: 'small', activity: 'moderate', aliases: [] },
  { name: 'Dachshund', size: 'small', activity: 'moderate', aliases: ['sausage dog', 'doxie'] },
  { name: 'Chihuahua', size: 'toy', activity: 'low', aliases: [] },
  { name: 'Shih Tzu', size: 'toy', activity: 'low', aliases: [] },
  { name: 'Pomeranian', size: 'toy', activity: 'moderate', aliases: ['pom'] },
  { name: 'Yorkshire Terrier', size: 'toy', activity: 'moderate', aliases: ['yorkie'] },
  { name: 'Jack Russell Terrier', size: 'small', activity: 'very_high', aliases: ['jack russell'] },
  { name: 'Cavalier King Charles Spaniel', size: 'small', activity: 'moderate', aliases: ['cavalier'] },
  { name: 'Cocker Spaniel', size: 'medium', activity: 'high', aliases: ['cocker'] },
  { name: 'Springer Spaniel', size: 'medium', activity: 'very_high', aliases: ['springer'] },
  { name: 'Australian Shepherd', size: 'medium', activity: 'very_high', aliases: ['aussie'] },
  { name: 'Siberian Husky', size: 'large', activity: 'very_high', aliases: ['husky'] },
  { name: 'Malamute', size: 'giant', activity: 'high', aliases: ['alaskan malamute'] },
  { name: 'Chow Chow', size: 'medium', activity: 'low', aliases: ['chow'] },
  { name: 'Shiba Inu', size: 'small', activity: 'moderate', aliases: ['shiba'] },
  { name: 'Akita', size: 'large', activity: 'moderate', aliases: [] },
  { name: 'Boxer', size: 'large', activity: 'high', aliases: [] },
  { name: 'Rottweiler', size: 'large', activity: 'moderate', aliases: ['rottie'] },
  { name: 'Doberman', size: 'large', activity: 'high', aliases: ['dobermann'] },
  { name: 'Great Dane', size: 'giant', activity: 'moderate', aliases: ['dane'] },
  { name: 'Bernese Mountain Dog', size: 'giant', activity: 'moderate', aliases: ['bernese'] },
  { name: 'Saint Bernard', size: 'giant', activity: 'low', aliases: [] },
  { name: 'Newfoundland', size: 'giant', activity: 'low', aliases: ['newfie'] },
  { name: 'Vizsla', size: 'medium', activity: 'very_high', aliases: [] },
  { name: 'Weimaraner', size: 'large', activity: 'very_high', aliases: [] },
  { name: 'Whippet', size: 'medium', activity: 'high', aliases: [] },
  { name: 'Greyhound', size: 'large', activity: 'moderate', aliases: [] },
  { name: 'Italian Greyhound', size: 'small', activity: 'moderate', aliases: ['iggy'] },
  { name: 'Basset Hound', size: 'medium', activity: 'low', aliases: ['basset'] },
  { name: 'Bloodhound', size: 'large', activity: 'moderate', aliases: [] },
  { name: 'Pug', size: 'small', activity: 'low', aliases: [] },
  { name: 'Boston Terrier', size: 'small', activity: 'moderate', aliases: [] },
  { name: 'Staffordshire Bull Terrier', size: 'medium', activity: 'high', aliases: ['staffy', 'staffie'] },
  { name: 'American Staffordshire Terrier', size: 'medium', activity: 'high', aliases: ['amstaff'] },
  { name: 'Bull Terrier', size: 'medium', activity: 'high', aliases: [] },
  { name: 'Corgi', size: 'small', activity: 'moderate', aliases: ['pembroke welsh corgi', 'welsh corgi'] },
  { name: 'Samoyed', size: 'large', activity: 'high', aliases: ['sammy'] },
  { name: 'Maltese', size: 'toy', activity: 'low', aliases: [] },
  { name: 'Bichon Frise', size: 'toy', activity: 'moderate', aliases: ['bichon'] },
  { name: 'Havanese', size: 'toy', activity: 'moderate', aliases: [] },
  { name: 'Papillon', size: 'toy', activity: 'moderate', aliases: [] },
  { name: 'Rhodesian Ridgeback', size: 'large', activity: 'high', aliases: ['ridgeback'] },
  { name: 'Belgian Malinois', size: 'large', activity: 'very_high', aliases: ['malinois'] },
  { name: 'Canaan Dog', size: 'medium', activity: 'high', aliases: ['canaan'] },
  { name: 'Mixed Breed', size: 'medium', activity: 'moderate', aliases: ['mix', 'mutt', 'crossbreed', 'rescue'] },
];

export const BREED_NAMES: string[] = BREEDS.map((b) => b.name);

export function findBreed(input: string): (typeof BREEDS)[number] | undefined {
  const needle = input.trim().toLowerCase();
  if (!needle) return undefined;
  return BREEDS.find(
    (b) => b.name.toLowerCase() === needle || (b.aliases ?? []).some((a) => a.toLowerCase() === needle),
  );
}
