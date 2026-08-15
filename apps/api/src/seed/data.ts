import type {
  ActivityLevel,
  Daypart,
  DogSex,
  DogSize,
  Interest,
  PlayStyle,
  Sociability,
  TemperamentTrait,
  Weekday,
} from '@doggystyle/shared';

export interface SeedDog {
  name: string;
  breed: string;
  ageYears: number;
  sex: DogSex;
  size: DogSize;
  weightKg: number;
  activityLevel: ActivityLevel;
  sociability: Sociability;
  playStyles: PlayStyle[];
  temperament: TemperamentTrait[];
  interests: Interest[];
  bio: string;
  goodWithSmallDogs: boolean;
  goodWithLargeDogs: boolean;
  goodWithPuppies: boolean;
  goodWithKids: boolean;
}

export interface SeedOwner {
  slug: string;
  displayName: string;
  city: string;
  dog: SeedDog;
  availability: Array<{ weekday: Weekday; daypart: Daypart }>;
  radiusKm: number;
  intents: string[];
  breeding?: {
    reproductiveStatus: 'intact' | 'neutered' | 'spayed';
    registrationNumber?: string;
    pedigree?: string;
    geneticTests?: string[];
    healthScreenings?: string[];
    vetClearance?: string;
    littersWhelped?: number;
    matingNotes?: string;
    availableFromDaysAgo?: number;
  };
}

/**
 * A believable neighbourhood: mostly central Tel Aviv so distances are small
 * and matching has something to rank, plus a few outliers to exercise the
 * radius filter. Milo (Border Collie) is the canonical demo match — the E2E
 * test and the demo video both introduce to him.
 */
export const SEED_OWNERS: SeedOwner[] = [
  {
    slug: 'owner1',
    displayName: 'Noa',
    city: 'Tel Aviv',
    radiusKm: 15,
    intents: ['playdate', 'walk'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'sun', daypart: 'evening' },
      { weekday: 'fri', daypart: 'morning' },
    ],
    dog: {
      name: 'Luna',
      breed: 'Golden Retriever',
      ageYears: 3,
      sex: 'female',
      size: 'large',
      weightKg: 28,
      activityLevel: 'high',
      sociability: 'very_social',
      playStyles: ['fetch', 'water', 'chase'],
      temperament: ['friendly' as TemperamentTrait, 'playful', 'affectionate'].filter(Boolean) as TemperamentTrait[],
      interests: ['beach', 'swimming', 'fetch', 'long_walks'],
      bio: 'Beach-obsessed and endlessly friendly. Will retrieve anything you throw, twice.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
    breeding: {
      reproductiveStatus: 'intact',
      registrationNumber: 'IKC-2023-44127',
      pedigree: 'Sired by Ch. Goldmeadow Aurora out of Sunhaven Reverie. Three generations documented.',
      geneticTests: ['prcd-PRA: clear', 'ICT-A: clear'],
      healthScreenings: ['Hips OFA Good (2025)', 'Elbows normal (2025)'],
      vetClearance: 'Full breeding soundness exam, Dr. Levi, March 2026',
      littersWhelped: 0,
      matingNotes: 'Looking for a health-tested working-line stud. Happy to share full paperwork.',
      availableFromDaysAgo: 30,
    },
  },
  {
    slug: 'owner2',
    displayName: 'Amir',
    city: 'Ramat Gan',
    radiusKm: 12,
    intents: ['playdate'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'wed', daypart: 'evening' },
    ],
    dog: {
      name: 'Kobi',
      breed: 'Labrador Retriever',
      ageYears: 5,
      sex: 'male',
      size: 'large',
      weightKg: 32,
      activityLevel: 'high',
      sociability: 'friendly',
      playStyles: ['fetch', 'water', 'wrestle'],
      temperament: ['playful', 'confident', 'goofy'],
      interests: ['fetch', 'swimming', 'dog_park', 'long_walks'],
      bio: 'Never says no to a tennis ball. Big, soft and slightly clumsy.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner3',
    displayName: 'Maya',
    city: 'Tel Aviv',
    radiusKm: 10,
    intents: ['playdate', 'running', 'walk'],
    availability: [
      { weekday: 'fri', daypart: 'morning' },
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'tue', daypart: 'evening' },
    ],
    dog: {
      name: 'Milo',
      breed: 'Border Collie',
      ageYears: 2,
      sex: 'male',
      size: 'medium',
      weightKg: 19,
      activityLevel: 'very_high',
      sociability: 'friendly',
      playStyles: ['chase', 'fetch', 'parallel_walk'],
      temperament: ['energetic', 'focused', 'curious'],
      interests: ['long_walks', 'running', 'agility', 'training', 'fetch'],
      bio: 'Tireless and clever. Happiest with a job to do and a long trail ahead.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: false,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner4',
    displayName: 'Daniel',
    city: 'Givatayim',
    radiusKm: 8,
    intents: ['walk', 'social'],
    availability: [
      { weekday: 'sun', daypart: 'morning' },
      { weekday: 'thu', daypart: 'afternoon' },
    ],
    dog: {
      name: 'One',
      breed: 'Chow Chow',
      ageYears: 1,
      sex: 'male',
      size: 'medium',
      weightKg: 22,
      activityLevel: 'moderate',
      sociability: 'selective',
      playStyles: ['parallel_walk', 'sniff_explore'],
      temperament: ['independent', 'calm', 'confident'],
      interests: ['long_walks', 'cafe_sitting', 'snuffle_games'],
      bio: 'Friendly, independent and enjoys medium-energy outdoor walks.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: false,
      goodWithPuppies: false,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner5',
    displayName: 'Tamar',
    city: 'Tel Aviv',
    radiusKm: 10,
    intents: ['playdate', 'walk'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'mon', daypart: 'evening' },
    ],
    dog: {
      name: 'Pixel',
      breed: 'French Bulldog',
      ageYears: 4,
      sex: 'female',
      size: 'small',
      weightKg: 11,
      activityLevel: 'low',
      sociability: 'friendly',
      playStyles: ['gentle', 'sniff_explore'],
      temperament: ['calm', 'affectionate', 'goofy'],
      interests: ['cafe_sitting', 'snuffle_games', 'long_walks'],
      bio: 'Small, snorty and extremely fond of pavement cafés.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: false,
      goodWithPuppies: true,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner6',
    displayName: 'Yuval',
    city: 'Tel Aviv',
    radiusKm: 20,
    intents: ['running', 'playdate'],
    availability: [
      { weekday: 'fri', daypart: 'early_morning' },
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'wed', daypart: 'early_morning' },
    ],
    dog: {
      name: 'Rocket',
      breed: 'Jack Russell Terrier',
      ageYears: 3,
      sex: 'male',
      size: 'small',
      weightKg: 8,
      activityLevel: 'very_high',
      sociability: 'selective',
      playStyles: ['chase', 'tug', 'fetch'],
      temperament: ['energetic', 'confident', 'vocal'],
      interests: ['running', 'agility', 'fetch', 'hiking'],
      bio: 'Small dog, enormous engine. Keeps up with bicycles and regrets nothing.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: false,
      goodWithKids: false,
    },
  },
  {
    slug: 'owner7',
    displayName: 'Shira',
    city: 'Ramat Gan',
    radiusKm: 15,
    intents: ['playdate', 'walk'],
    availability: [
      { weekday: 'sat', daypart: 'afternoon' },
      { weekday: 'sun', daypart: 'morning' },
    ],
    dog: {
      name: 'Nala',
      breed: 'Cocker Spaniel',
      ageYears: 6,
      sex: 'female',
      size: 'medium',
      weightKg: 14,
      activityLevel: 'high',
      sociability: 'friendly',
      playStyles: ['fetch', 'sniff_explore', 'parallel_walk'],
      temperament: ['affectionate', 'curious', 'patient'],
      interests: ['long_walks', 'beach', 'snuffle_games'],
      bio: 'Gentle, nose-led and always ready for one more lap of the park.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner8',
    displayName: 'Omer',
    city: 'Herzliya',
    radiusKm: 25,
    intents: ['playdate', 'mating'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'thu', daypart: 'evening' },
    ],
    dog: {
      name: 'Ziggy',
      breed: 'Golden Retriever',
      ageYears: 4,
      sex: 'male',
      size: 'large',
      weightKg: 34,
      activityLevel: 'high',
      sociability: 'very_social',
      playStyles: ['fetch', 'water', 'chase'],
      temperament: ['friendly' as TemperamentTrait, 'confident', 'patient'].filter(Boolean) as TemperamentTrait[],
      interests: ['swimming', 'beach', 'fetch', 'hiking'],
      bio: 'Show-line golden with a soft mouth and an even softer temperament.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
    breeding: {
      reproductiveStatus: 'intact',
      registrationNumber: 'IKC-2022-19883',
      pedigree: 'Ch. Sunhaven Ambassador × Goldmeadow Solstice. Four generations documented, two champions.',
      geneticTests: ['prcd-PRA: clear', 'ICT-A: clear', 'DM: clear', 'MD: clear'],
      healthScreenings: ['Hips OFA Excellent (2024)', 'Elbows normal (2024)', 'Cardiac normal (2025)', 'Eyes CERF clear (2026)'],
      vetClearance: 'Breeding soundness exam, Dr. Cohen, January 2026',
      littersWhelped: 2,
      matingNotes: 'Proven stud. Full health paperwork available on request; happy to meet first.',
      availableFromDaysAgo: 60,
    },
  },
  {
    slug: 'owner9',
    displayName: 'Lior',
    city: 'Tel Aviv',
    radiusKm: 12,
    intents: ['playdate', 'walk'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'fri', daypart: 'afternoon' },
    ],
    dog: {
      name: 'Sesame',
      breed: 'Mixed Breed',
      ageYears: 7,
      sex: 'female',
      size: 'medium',
      weightKg: 17,
      activityLevel: 'moderate',
      sociability: 'friendly',
      playStyles: ['parallel_walk', 'sniff_explore', 'gentle'],
      temperament: ['calm', 'patient', 'affectionate'],
      interests: ['long_walks', 'cafe_sitting', 'dog_park'],
      bio: 'Rescue, seven years old, entirely unbothered by anything. Excellent company.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
  },
  {
    slug: 'owner10',
    displayName: 'Michal',
    city: 'Rishon LeZion',
    radiusKm: 20,
    intents: ['playdate', 'social'],
    availability: [
      { weekday: 'sat', daypart: 'morning' },
      { weekday: 'sun', daypart: 'afternoon' },
    ],
    dog: {
      name: 'Bamba',
      breed: 'Samoyed',
      ageYears: 2,
      sex: 'female',
      size: 'large',
      weightKg: 24,
      activityLevel: 'high',
      sociability: 'very_social',
      playStyles: ['chase', 'wrestle', 'fetch'],
      temperament: ['playful', 'goofy', 'vocal'],
      interests: ['hiking', 'dog_park', 'running', 'long_walks'],
      bio: 'A cloud with opinions. Talks constantly, loves everyone.',
      goodWithSmallDogs: true,
      goodWithLargeDogs: true,
      goodWithPuppies: true,
      goodWithKids: true,
    },
  },
];

export const DEMO_PASSWORD = 'Demo123!';
export const DEMO_EMAIL_DOMAIN = 'demo.doggystyle.local';

export const SEED_CONVERSATION: string[] = [
  'Hi! Sesame and Bamba got on really well at the park last week 🙂',
  'They did! Bamba slept for about four hours afterwards.',
  'Same for Sesame. Fancy doing it again on Saturday morning?',
  'Saturday works for us — the north end of the park is usually quiet then.',
];
