/**
 * Wire types shared between the API and the web client.
 * These describe exactly what crosses the network — note that no DTO here has a field
 * for exact coordinates. See docs/THREAT_MODEL.md §"Information disclosure".
 */

import type {
  ActivityLevel,
  AttributeSource,
  Daypart,
  DogSex,
  DogSize,
  Interest,
  LocationPrecision,
  MatchIntent,
  MatchRequestStatus,
  MeetupStatus,
  PlayStyle,
  ProfileVisibility,
  ReportReason,
  ReproductiveStatus,
  Sociability,
  SocialProviderId,
  TemperamentTrait,
  Weekday,
} from './domain.js';

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface CoarseLocation {
  /** Human-readable, coarse. e.g. "Haifa, IL" */
  label: string | null;
  city: string | null;
  country: string | null;
  /** 5-char geohash ≈ 4.9km × 4.9km cell. Never finer than this over the wire. */
  geohash: string | null;
  precision: LocationPrecision;
}

export interface AttributeProvenance<T = unknown> {
  value: T;
  source: AttributeSource;
  confidence: number;
  userConfirmed: boolean;
  updatedAt: string;
}

export interface ViewerDto {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  createdAt: string;
  location: CoarseLocation;
  hasDog: boolean;
  demoMode: boolean;
}

export interface MediaAssetDto {
  id: string;
  url: string;
  thumbUrl: string;
  width: number | null;
  height: number | null;
  isProfilePhoto: boolean;
  dogScore: number | null;
  qualityScore: number | null;
  caption: string | null;
  source: SocialProviderId | 'manual';
  clusterId: string | null;
  createdAt: string;
}

export interface BreedingInfoDto {
  reproductiveStatus: ReproductiveStatus | null;
  registrationNumber: string | null;
  pedigree: string | null;
  geneticTests: string[];
  healthScreenings: string[];
  vetClearance: string | null;
  lastSeasonDate: string | null;
  littersWhelped: number | null;
  availableFrom: string | null;
  matingNotes: string | null;
  /** 0..1 — how much of the breeding data set has been provided by the owner. */
  completeness: number;
  missingFields: string[];
}

export interface DogProfileDto {
  id: string;
  name: string | null;
  breed: string | null;
  breedSecondary: string | null;
  ageYears: number | null;
  ageMonths: number | null;
  sex: DogSex;
  size: DogSize | null;
  weightKg: number | null;
  activityLevel: ActivityLevel | null;
  sociability: Sociability | null;
  playStyles: PlayStyle[];
  temperament: TemperamentTrait[];
  interests: Interest[];
  bio: string | null;
  goodWithSmallDogs: boolean | null;
  goodWithLargeDogs: boolean | null;
  goodWithPuppies: boolean | null;
  goodWithKids: boolean | null;
  restrictions: string[];
  visibility: ProfileVisibility;
  location: CoarseLocation;
  photos: MediaAssetDto[];
  profilePhotoUrl: string | null;
  /** Per-attribute provenance for everything the system inferred. */
  attributes: Record<string, AttributeProvenance>;
  /** Attributes the system inferred but the owner has not confirmed yet. */
  unconfirmedKeys: string[];
  breeding: BreedingInfoDto | null;
  completeness: number;
  createdAt: string;
  updatedAt: string;
}

export interface PreferencesDto {
  radiusKm: number;
  intents: MatchIntent[];
  minAgeYears: number | null;
  maxAgeYears: number | null;
  sizes: DogSize[];
  sexes: DogSex[];
  breeds: string[];
  minActivity: ActivityLevel | null;
  availability: AvailabilitySlotDto[];
  locationPrecision: LocationPrecision;
  notes: string | null;
}

export interface AvailabilitySlotDto {
  id?: string;
  weekday: Weekday;
  daypart: Daypart;
}

export interface MatchSignalDto {
  key: string;
  label: string;
  /** -1..1 — how much this signal helped (positive) or hurt (negative). */
  contribution: number;
  weight: number;
  detail: string;
}

export interface MatchCandidateDto {
  id: string;
  dogId: string;
  ownerId: string;
  name: string;
  breed: string | null;
  ageYears: number | null;
  size: DogSize | null;
  sex: DogSex;
  photoUrl: string | null;
  /** Bucketed. e.g. "~4 km away". Never a precise distance. */
  distanceLabel: string;
  distanceKm: number | null;
  score: number;
  intent: MatchIntent;
  reasons: string[];
  conflicts: string[];
  dataGaps: string[];
  signals: MatchSignalDto[];
  bio: string | null;
  introductionStatus: MatchRequestStatus | 'none';
  connectionId: string | null;
}

export interface SearchResultDto {
  searchId: string;
  intent: MatchIntent;
  interpreted: ParsedIntentDto;
  candidates: MatchCandidateDto[];
  totalConsidered: number;
  filteredOut: Record<string, number>;
  notes: string[];
  disclaimer: string | null;
}

export interface ParsedIntentDto {
  intent: MatchIntent;
  breedPreference: string | null;
  temperament: TemperamentTrait[];
  activityLevel: ActivityLevel | null;
  sizes: DogSize[];
  sexes: DogSex[];
  minAgeYears: number | null;
  maxAgeYears: number | null;
  radiusKm: number | null;
  availability: { weekday: Weekday | null; daypart: Daypart | null; label: string | null } | null;
  reproductiveStatus: ReproductiveStatus | null;
  freeText: string;
  confidence: number;
}

/* ── Chat ─────────────────────────────────────────────────────────────────── */

export type ChatAttachment =
  | { kind: 'dog_profile'; profile: DogProfileDto }
  | { kind: 'profile_draft'; profile: DogProfileDto; draftId: string }
  | { kind: 'matches'; result: SearchResultDto }
  | { kind: 'candidate'; candidate: MatchCandidateDto }
  | { kind: 'introduction'; request: MatchRequestDto }
  | { kind: 'meetup'; meetup: MeetupDto }
  | { kind: 'media_import'; summary: MediaImportSummaryDto }
  | { kind: 'connect_prompt'; providers: SocialProviderDescriptorDto[] }
  | { kind: 'confirmation'; confirmation: PendingConfirmationDto }
  | { kind: 'conversation_link'; connectionId: string; peerDogName: string }
  | { kind: 'notice'; tone: 'info' | 'warning'; title: string; body: string };

export interface ChatMessageDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  attachments: ChatAttachment[];
  suggestions: string[];
  createdAt: string;
}

export interface PendingConfirmationDto {
  id: string;
  action: string;
  summary: string;
  detail: string[];
  args: Record<string, unknown>;
  expiresAt: string;
}

export interface ChatTurnDto {
  conversationId: string;
  messages: ChatMessageDto[];
}

/* ── Social / media import ────────────────────────────────────────────────── */

export interface SocialProviderDescriptorDto {
  id: SocialProviderId;
  label: string;
  description: string;
  available: boolean;
  /** Why it is unavailable, when it is. Rendered verbatim to the user. */
  unavailableReason: string | null;
  kind: 'oauth' | 'upload' | 'archive' | 'demo';
  connected: boolean;
  accountLabel: string | null;
}

export interface MediaImportSummaryDto {
  importId: string;
  provider: SocialProviderId;
  itemsFetched: number;
  itemsStored: number;
  duplicates: number;
  dogPhotos: number;
  clusters: { clusterId: string; count: number; coverUrl: string | null; suggestedName: string | null }[];
  status: 'queued' | 'running' | 'complete' | 'failed';
  message: string | null;
}

/* ── Connections, messaging, meetups ──────────────────────────────────────── */

export interface MatchRequestDto {
  id: string;
  status: MatchRequestStatus;
  direction: 'outgoing' | 'incoming';
  intent: MatchIntent;
  message: string | null;
  fromDog: { id: string; name: string; photoUrl: string | null; breed: string | null };
  toDog: { id: string; name: string; photoUrl: string | null; breed: string | null };
  reasons: string[];
  createdAt: string;
  respondedAt: string | null;
  connectionId: string | null;
}

export interface ConnectionSummaryDto {
  connectionId: string;
  conversationId: string;
  peerDog: { id: string; name: string; photoUrl: string | null; breed: string | null };
  peerOwnerDisplayName: string;
  intent: MatchIntent;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  meetupCount: number;
  status: 'active' | 'revoked';
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderUserId: string | null;
  kind: 'text' | 'system' | 'meetup_proposal' | 'meetup_update' | 'introduction';
  body: string;
  metadata: Record<string, unknown> | null;
  mine: boolean;
  createdAt: string;
}

export interface MeetupDto {
  id: string;
  connectionId: string;
  status: MeetupStatus;
  intent: MatchIntent;
  title: string;
  startsAt: string;
  endsAt: string;
  /** A suggested public area, not anyone's address. */
  locationLabel: string;
  locationNote: string | null;
  proposedByUserId: string;
  proposedByMe: boolean;
  acceptedByUserIds: string[];
  participants: { userId: string; dogId: string; dogName: string; photoUrl: string | null }[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ── Moderation & admin ───────────────────────────────────────────────────── */

export interface ReportDto {
  id: string;
  reporterUserId: string;
  reportedUserId: string;
  reason: ReportReason;
  detail: string | null;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AdminUserRowDto {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'suspended' | 'deleted';
  dogCount: number;
  reportsAgainst: number;
  createdAt: string;
  lastSeenAt: string | null;
}

export interface AuditEventDto {
  id: string;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface JobRowDto {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'dead_letter';
  attempts: number;
  lastError: string | null;
  runAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface HealthDto {
  status: 'ok' | 'degraded';
  version: string;
  uptimeSeconds: number;
  checks: { name: string; ok: boolean; detail?: string }[];
}
