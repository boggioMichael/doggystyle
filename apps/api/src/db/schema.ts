import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/* ─────────────────────────────────────────────────────────────────────────────
 * Identity & auth
 * ───────────────────────────────────────────────────────────────────────────*/

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailNormalized: text('email_normalized').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    displayName: text('display_name'),
    role: text('role').notNull().default('user'), // user | admin
    status: text('status').notNull().default('active'), // active | suspended | deleted
    /** Coarse location only. Exact coords live in `exactLat/exactLng` and are opt-in. */
    city: text('city'),
    country: text('country'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    geohash: text('geohash'),
    exactLat: doublePrecision('exact_lat'),
    exactLng: doublePrecision('exact_lng'),
    locationPrecision: text('location_precision').notNull().default('city'),
    timezone: text('timezone'),
    /** Self-attested 18+. See docs/THREAT_MODEL.md §R2. */
    ageAttestedAt: timestamp('age_attested_at', { withTimezone: true }),
    plan: text('plan').notNull().default('free'),
    entitlements: jsonb('entitlements').$type<string[]>().notNull().default([]),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_normalized_uq').on(t.emailNormalized), index('users_geohash_idx').on(t.geohash)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256(token + pepper). The raw token never touches the database. */
    tokenHash: text('token_hash').notNull(),
    csrfSecret: text('csrf_secret').notNull(),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sessions_token_hash_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

export const loginTokens = pgTable(
  'login_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    emailNormalized: text('email_normalized').notNull(),
    tokenHash: text('token_hash').notNull(),
    purpose: text('purpose').notNull().default('magic_link'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('login_tokens_hash_uq').on(t.tokenHash), index('login_tokens_email_idx').on(t.emailNormalized)],
);

export const consentEvents = pgTable(
  'consent_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // terms | privacy | age_18 | social_import | location_share
    granted: boolean('granted').notNull(),
    version: text('version').notNull().default('1'),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('consent_events_user_idx').on(t.userId)],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Dogs & profiles
 * ───────────────────────────────────────────────────────────────────────────*/

export const dogs = pgTable(
  'dogs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'),
    status: text('status').notNull().default('active'), // draft | active | archived
    isPrimary: boolean('is_primary').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dogs_owner_idx').on(t.ownerId)],
);

export const dogProfiles = pgTable(
  'dog_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    breed: text('breed'),
    breedSecondary: text('breed_secondary'),
    birthDate: timestamp('birth_date', { withTimezone: true }),
    ageYears: real('age_years'),
    sex: text('sex').notNull().default('unknown'),
    size: text('size'),
    weightKg: real('weight_kg'),
    activityLevel: text('activity_level'),
    sociability: text('sociability'),
    playStyles: jsonb('play_styles').$type<string[]>().notNull().default([]),
    temperament: jsonb('temperament').$type<string[]>().notNull().default([]),
    interests: jsonb('interests').$type<string[]>().notNull().default([]),
    bio: text('bio'),
    goodWithSmallDogs: boolean('good_with_small_dogs'),
    goodWithLargeDogs: boolean('good_with_large_dogs'),
    goodWithPuppies: boolean('good_with_puppies'),
    goodWithKids: boolean('good_with_kids'),
    restrictions: jsonb('restrictions').$type<string[]>().notNull().default([]),
    visibility: text('visibility').notNull().default('public'),
    profilePhotoId: uuid('profile_photo_id'),
    /** Owner-level coarse location is copied here for fast geo filtering. */
    city: text('city'),
    country: text('country'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    geohash: text('geohash'),
    completeness: real('completeness').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('dog_profiles_dog_uq').on(t.dogId),
    index('dog_profiles_geo_idx').on(t.lat, t.lng),
    index('dog_profiles_visibility_idx').on(t.visibility),
  ],
);

/**
 * Per-attribute provenance. This is what makes "never invent facts" enforceable.
 * A DB CHECK constraint (see migration 0001) rejects model-sourced sensitive keys.
 */
export const dogProfileAttributes = pgTable(
  'dog_profile_attributes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    source: text('source').notNull(),
    confidence: real('confidence').notNull().default(0),
    userConfirmed: boolean('user_confirmed').notNull().default(false),
    sensitive: boolean('sensitive').notNull().default(false),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dog_attr_dog_key_uq').on(t.dogId, t.key)],
);

export const dogProfileAttributeHistory = pgTable(
  'dog_profile_attribute_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    previousValue: jsonb('previous_value'),
    newValue: jsonb('new_value'),
    source: text('source').notNull(),
    changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dog_attr_hist_dog_idx').on(t.dogId, t.key)],
);

/** Owner-entered or verified breeding data only — never model-inferred. */
export const breedingRecords = pgTable(
  'breeding_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    reproductiveStatus: text('reproductive_status'),
    registrationNumber: text('registration_number'),
    pedigree: text('pedigree'),
    geneticTests: jsonb('genetic_tests').$type<string[]>().notNull().default([]),
    healthScreenings: jsonb('health_screenings').$type<string[]>().notNull().default([]),
    vetClearance: text('vet_clearance'),
    lastSeasonDate: timestamp('last_season_date', { withTimezone: true }),
    littersWhelped: integer('litters_whelped'),
    availableFrom: timestamp('available_from', { withTimezone: true }),
    matingNotes: text('mating_notes'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: text('verified_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('breeding_records_dog_uq').on(t.dogId)],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Social accounts & media
 * ───────────────────────────────────────────────────────────────────────────*/

export const socialAccounts = pgTable(
  'social_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    handle: text('handle'),
    displayName: text('display_name'),
    /** AES-256-GCM ciphertext. Plaintext tokens are never stored. */
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('social_accounts_user_provider_ext_uq').on(t.userId, t.provider, t.externalId),
    index('social_accounts_user_idx').on(t.userId),
  ],
);

export const mediaImports = pgTable(
  'media_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    socialAccountId: uuid('social_account_id').references(() => socialAccounts.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    status: text('status').notNull().default('queued'),
    itemsFetched: integer('items_fetched').notNull().default(0),
    itemsStored: integer('items_stored').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('media_imports_user_idx').on(t.userId)],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id').references(() => dogs.id, { onDelete: 'set null' }),
    importId: uuid('import_id').references(() => mediaImports.id, { onDelete: 'set null' }),
    provider: text('provider').notNull().default('manual'),
    externalId: text('external_id'),
    /** Relative path inside MEDIA_DIR. Never served as a static directory. */
    storageKey: text('storage_key').notNull(),
    thumbKey: text('thumb_key'),
    mimeType: text('mime_type').notNull(),
    bytes: integer('bytes').notNull().default(0),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256').notNull(),
    /** Perceptual hash used for near-duplicate detection. */
    dhash: text('dhash'),
    caption: text('caption'),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    /** 0..1 likelihood the image contains a dog. */
    dogScore: real('dog_score'),
    qualityScore: real('quality_score'),
    /** Cheap visual signature used for per-dog clustering. */
    signature: jsonb('signature').$type<number[]>(),
    clusterId: text('cluster_id'),
    status: text('status').notNull().default('pending'), // pending | processed | rejected | duplicate
    rejectedReason: text('rejected_reason'),
    isProfilePhoto: boolean('is_profile_photo').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('media_assets_user_idx').on(t.userId),
    index('media_assets_dog_idx').on(t.dogId),
    index('media_assets_cluster_idx').on(t.userId, t.clusterId),
    uniqueIndex('media_assets_user_sha_uq').on(t.userId, t.sha256),
  ],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Preferences, availability, search & matching
 * ───────────────────────────────────────────────────────────────────────────*/

export const preferences = pgTable(
  'preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id').references(() => dogs.id, { onDelete: 'cascade' }),
    radiusKm: real('radius_km').notNull().default(15),
    intents: jsonb('intents').$type<string[]>().notNull().default(['playdate']),
    minAgeYears: real('min_age_years'),
    maxAgeYears: real('max_age_years'),
    sizes: jsonb('sizes').$type<string[]>().notNull().default([]),
    sexes: jsonb('sexes').$type<string[]>().notNull().default([]),
    breeds: jsonb('breeds').$type<string[]>().notNull().default([]),
    minActivity: text('min_activity'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('preferences_user_dog_uq').on(t.userId, t.dogId)],
);

export const availability = pgTable(
  'availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id').references(() => dogs.id, { onDelete: 'cascade' }),
    weekday: text('weekday').notNull(),
    daypart: text('daypart').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('availability_uq').on(t.userId, t.dogId, t.weekday, t.daypart)],
);

export const searches = pgTable(
  'searches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    intent: text('intent').notNull(),
    rawQuery: text('raw_query'),
    parsedIntent: jsonb('parsed_intent').$type<Record<string, unknown>>().notNull(),
    constraints: jsonb('constraints').$type<Record<string, unknown>>().notNull(),
    totalConsidered: integer('total_considered').notNull().default(0),
    filteredOut: jsonb('filtered_out').$type<Record<string, number>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('searches_user_idx').on(t.userId), index('searches_dog_idx').on(t.dogId)],
);

export const candidateMatches = pgTable(
  'candidate_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    searchId: uuid('search_id')
      .notNull()
      .references(() => searches.id, { onDelete: 'cascade' }),
    subjectDogId: uuid('subject_dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    candidateDogId: uuid('candidate_dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    score: real('score').notNull(),
    rank: integer('rank').notNull(),
    distanceKm: real('distance_km'),
    signals: jsonb('signals').$type<unknown[]>().notNull().default([]),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    conflicts: jsonb('conflicts').$type<string[]>().notNull().default([]),
    dataGaps: jsonb('data_gaps').$type<string[]>().notNull().default([]),
    /** Feedback loop for future recommendation learning. */
    outcome: text('outcome'), // shown | dismissed | introduced | connected | met
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('candidate_matches_search_idx').on(t.searchId),
    uniqueIndex('candidate_matches_search_dog_uq').on(t.searchId, t.candidateDogId),
  ],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Introductions, connections, messaging
 * ───────────────────────────────────────────────────────────────────────────*/

export const matchRequests = pgTable(
  'match_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromUserId: uuid('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: uuid('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromDogId: uuid('from_dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    toDogId: uuid('to_dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    candidateMatchId: uuid('candidate_match_id').references(() => candidateMatches.id, { onDelete: 'set null' }),
    intent: text('intent').notNull(),
    message: text('message'),
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('pending'),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('match_requests_to_idx').on(t.toUserId, t.status),
    index('match_requests_from_idx').on(t.fromUserId, t.status),
    uniqueIndex('match_requests_pair_pending_uq').on(t.fromDogId, t.toDogId, t.status),
  ],
);

/** Created only after mutual consent. Owns exactly one conversation. */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** userAId < userBId lexicographically, so a pair has one canonical row. */
    userAId: uuid('user_a_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userBId: uuid('user_b_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogAId: uuid('dog_a_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    dogBId: uuid('dog_b_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    matchRequestId: uuid('match_request_id').references(() => matchRequests.id, { onDelete: 'set null' }),
    intent: text('intent').notNull(),
    status: text('status').notNull().default('active'), // active | revoked
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connections_pair_uq').on(t.dogAId, t.dogBId),
    index('connections_user_a_idx').on(t.userAId),
    index('connections_user_b_idx').on(t.userBId),
  ],
);

/** The dog-to-dog social graph: who met whom, how often, how it went. */
export const dogConnections = pgTable(
  'dog_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dogAId: uuid('dog_a_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    dogBId: uuid('dog_b_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    meetCount: integer('meet_count').notNull().default(0),
    lastMetAt: timestamp('last_met_at', { withTimezone: true }),
    rapport: real('rapport'), // -1..1, derived from meetup outcomes
    wantsAgain: boolean('wants_again'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dog_connections_pair_uq').on(t.dogAId, t.dogBId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('conversations_connection_uq').on(t.connectionId)],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderUserId: uuid('sender_user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull().default('text'),
    body: text('body').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/** Adapter records for future external transports (WhatsApp/SMS/Messenger). */
export const messageDeliveries = pgTable('message_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  transport: text('transport').notNull().default('internal'),
  status: text('status').notNull().default('delivered'),
  externalId: text('external_id'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Meetups
 * ───────────────────────────────────────────────────────────────────────────*/

export const meetups = pgTable(
  'meetups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    proposedByUserId: uuid('proposed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    intent: text('intent').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('proposed'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** A public place suggestion. Never a home address. */
    locationLabel: text('location_label').notNull(),
    locationNote: text('location_note'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    notes: text('notes'),
    cancelledByUserId: uuid('cancelled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    cancelReason: text('cancel_reason'),
    outcome: text('outcome'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('meetups_connection_idx').on(t.connectionId), index('meetups_starts_idx').on(t.startsAt)],
);

/** n-ary from day one so group meetups need no schema change. */
export const meetupParticipants = pgTable(
  'meetup_participants',
  {
    meetupId: uuid('meetup_id')
      .notNull()
      .references(() => meetups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id')
      .notNull()
      .references(() => dogs.id, { onDelete: 'cascade' }),
    response: text('response').notNull().default('pending'), // pending | accepted | declined
    respondedAt: timestamp('responded_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.meetupId, t.userId] })],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Assistant (chat) — separate from peer messaging
 * ───────────────────────────────────────────────────────────────────────────*/

export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title'),
    /** Scratch state for the dialogue policy (last search id, pending slot-fills, …). */
    state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_threads_user_idx').on(t.userId)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    text: text('text').notNull(),
    attachments: jsonb('attachments').$type<unknown[]>().notNull().default([]),
    suggestions: jsonb('suggestions').$type<string[]>().notNull().default([]),
    actionName: text('action_name'),
    actionArgs: jsonb('action_args').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('chat_messages_thread_idx').on(t.threadId, t.createdAt)],
);

/** Sensitive agent actions park here until the human explicitly confirms. */
export const agentConfirmations = pgTable(
  'agent_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').references(() => chatThreads.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    args: jsonb('args').$type<Record<string, unknown>>().notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').$type<string[]>().notNull().default([]),
    status: text('status').notNull().default('pending'), // pending | confirmed | cancelled | expired
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_confirmations_user_idx').on(t.userId, t.status)],
);

/* ─────────────────────────────────────────────────────────────────────────────
 * Safety, moderation, audit, ops
 * ───────────────────────────────────────────────────────────────────────────*/

export const blocks = pgTable(
  'blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blockerUserId: uuid('blocker_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedUserId: uuid('blocked_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('blocks_pair_uq').on(t.blockerUserId, t.blockedUserId),
    index('blocks_blocked_idx').on(t.blockedUserId),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reporterUserId: uuid('reporter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportedUserId: uuid('reported_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reportedDogId: uuid('reported_dog_id').references(() => dogs.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    detail: text('detail'),
    status: text('status').notNull().default('open'),
    resolutionNote: text('resolution_note'),
    resolvedByUserId: uuid('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('reports_status_idx').on(t.status), index('reports_reported_idx').on(t.reportedUserId)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    summary: text('summary'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    ipHash: text('ip_hash'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_events_actor_idx').on(t.actorUserId), index('audit_events_created_idx').on(t.createdAt)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastError: text('last_error'),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('jobs_claim_idx').on(t.status, t.runAt), uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);

/** Dev-mode mailbox so magic links are visible without an SMTP server. */
export const outboundEmails = pgTable(
  'outbound_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toAddress: text('to_address').notNull(),
    subject: text('subject').notNull(),
    body: text('body').notNull(),
    /** Extracted action link, surfaced in the dev mailbox UI. */
    link: text('link'),
    transport: text('transport').notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('outbound_emails_created_idx').on(t.createdAt)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dogId: uuid('dog_id').references(() => dogs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // identity | vet | breeder | pedigree
    status: text('status').notNull().default('pending'),
    evidenceNote: text('evidence_note'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verifications_user_idx').on(t.userId)],
);

export const schema = {
  users,
  sessions,
  loginTokens,
  consentEvents,
  dogs,
  dogProfiles,
  dogProfileAttributes,
  dogProfileAttributeHistory,
  breedingRecords,
  socialAccounts,
  mediaImports,
  mediaAssets,
  preferences,
  availability,
  searches,
  candidateMatches,
  matchRequests,
  connections,
  dogConnections,
  conversations,
  messages,
  messageDeliveries,
  meetups,
  meetupParticipants,
  chatThreads,
  chatMessages,
  agentConfirmations,
  blocks,
  reports,
  auditEvents,
  jobs,
  notifications,
  outboundEmails,
  verifications,
};
