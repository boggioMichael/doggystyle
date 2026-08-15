import { z } from 'zod';
import {
  ACTIVITY_LEVELS,
  DOG_SEXES,
  DOG_SIZES,
  INTERESTS,
  MATCH_INTENTS,
  PLAY_STYLES,
  REPRODUCTIVE_STATUSES,
  SOCIABILITY,
  TEMPERAMENT_TRAITS,
  WEEKDAYS,
  DAYPARTS,
} from '@doggystyle/shared';
import { AGENT_ACTIONS } from '@doggystyle/shared';

/* ── Intent parsing ───────────────────────────────────────────────────────── */

export const parsedIntentSchema = z.object({
  intent: z.enum(MATCH_INTENTS),
  breedPreference: z.string().nullable().default(null),
  temperament: z.array(z.enum(TEMPERAMENT_TRAITS)).default([]),
  activityLevel: z.enum(ACTIVITY_LEVELS).nullable().default(null),
  sizes: z.array(z.enum(DOG_SIZES)).default([]),
  sexes: z.array(z.enum(DOG_SEXES)).default([]),
  minAgeYears: z.number().min(0).max(30).nullable().default(null),
  maxAgeYears: z.number().min(0).max(30).nullable().default(null),
  radiusKm: z.number().min(0.5).max(500).nullable().default(null),
  availability: z
    .object({
      weekday: z.enum(WEEKDAYS).nullable().default(null),
      daypart: z.enum(DAYPARTS).nullable().default(null),
      label: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  reproductiveStatus: z.enum(REPRODUCTIVE_STATUSES).nullable().default(null),
  freeText: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;

/* ── Conversational control ───────────────────────────────────────────────── */

export const agentDecisionSchema = z.object({
  action: z.enum(AGENT_ACTIONS),
  args: z.record(z.unknown()).default({}),
  reply: z.string().default(''),
  suggestions: z.array(z.string()).max(4).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type AgentDecision = z.infer<typeof agentDecisionSchema>;

/* ── Profile extraction ───────────────────────────────────────────────────── */

export const attributeCandidateSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().default(''),
});

export const profileExtractionSchema = z.object({
  name: z.string().nullable().default(null),
  breed: z.string().nullable().default(null),
  breedSecondary: z.string().nullable().default(null),
  ageYears: z.number().min(0).max(30).nullable().default(null),
  sex: z.enum(DOG_SEXES).default('unknown'),
  size: z.enum(DOG_SIZES).nullable().default(null),
  activityLevel: z.enum(ACTIVITY_LEVELS).nullable().default(null),
  sociability: z.enum(SOCIABILITY).nullable().default(null),
  playStyles: z.array(z.enum(PLAY_STYLES)).default([]),
  temperament: z.array(z.enum(TEMPERAMENT_TRAITS)).default([]),
  interests: z.array(z.enum(INTERESTS)).default([]),
  bio: z.string().nullable().default(null),
  attributes: z.array(attributeCandidateSchema).default([]),
});

export type ProfileExtraction = z.infer<typeof profileExtractionSchema>;

export interface ProfileExtractionInput {
  captions: string[];
  ownerNotes: string[];
  /** Aggregate statistics from the media pipeline — never raw pixels. */
  mediaFeatures: {
    photoCount: number;
    averageBrightness: number;
    averageSaturation: number;
    dominantHues: number[];
    /** 0..1 — proportion of frame occupied by the likely subject. */
    subjectFill: number;
    outdoorRatio: number;
    motionRatio: number;
  };
  knownAttributes: Record<string, unknown>;
}

/* ── Match explanation ────────────────────────────────────────────────────── */

export const matchExplanationSchema = z.object({
  reasons: z.array(z.string()).max(5).default([]),
  conflicts: z.array(z.string()).max(4).default([]),
});

export type MatchExplanation = z.infer<typeof matchExplanationSchema>;

export interface MatchExplanationInput {
  subject: { name: string; breed: string | null; ageYears: number | null; size: string | null };
  candidate: { name: string; breed: string | null; ageYears: number | null; size: string | null };
  intent: string;
  distanceLabel: string;
  /** Only the computed signal contributions — the model cannot see raw profiles. */
  signals: { key: string; label: string; contribution: number; weight: number; detail: string }[];
  hardConflicts: string[];
  dataGaps: string[];
}

/* ── Media understanding ──────────────────────────────────────────────────── */

export interface MediaFeatures {
  /** 0..1 likelihood the image contains a dog. */
  dogScore: number;
  /** 0..1 technical + framing quality. */
  qualityScore: number;
  /** Compact visual descriptor used for per-dog clustering. */
  signature: number[];
  brightness: number;
  saturation: number;
  sharpness: number;
  subjectFill: number;
  outdoor: boolean;
}

/* ── Provider interface ───────────────────────────────────────────────────── */

export interface AiProvider {
  readonly id: 'heuristic' | 'anthropic';

  parseIntent(input: { utterance: string; context: IntentContext }): Promise<ParsedIntent>;

  decideAction(input: { utterance: string; context: AgentContext }): Promise<AgentDecision>;

  extractProfile(input: ProfileExtractionInput): Promise<ProfileExtraction>;

  explainMatch(input: MatchExplanationInput): Promise<MatchExplanation>;

  /** Image understanding always runs locally — pixels never leave the machine. */
  analyseImage(buffer: Buffer): Promise<MediaFeatures>;
}

export interface IntentContext {
  dogName: string | null;
  dogBreed: string | null;
  dogAgeYears: number | null;
  defaultRadiusKm: number;
  city: string | null;
  /** ISO date, so relative expressions like "this weekend" can be resolved. */
  now: string;
}

export interface AgentContext extends IntentContext {
  hasDog: boolean;
  hasProfileDraft: boolean;
  hasConnectedSource: boolean;
  photoCount: number;
  lastSearchId: string | null;
  lastCandidateNames: string[];
  pendingIntroductions: number;
  openConnections: { peerDogName: string; connectionId: string }[];
  upcomingMeetups: number;
  recentTurns: { role: 'user' | 'assistant'; text: string }[];
}
