import {
  ACTIVITY_LEVELS,
  ATTRIBUTE_SOURCES,
  DOG_SEXES,
  DOG_SIZES,
  INFERABLE_ATTRIBUTE_KEYS,
  INTERESTS,
  LOCATION_PRECISIONS,
  PLAY_STYLES,
  REPRODUCTIVE_STATUSES,
  SOCIABILITY,
  TEMPERAMENT_TRAITS,
  TRUSTED_ATTRIBUTE_SOURCES,
  findBreed,
  isSensitiveAttributeKey,
  type ActivityLevel,
  type AttributeProvenance,
  type AttributeSource,
  type BreedingInfoDto,
  type DogProfileDto,
  type DogSex,
  type DogSize,
  type Interest,
  type LocationPrecision,
  type PlayStyle,
  type ProfileVisibility,
  type ReproductiveStatus,
  type Sociability,
  type TemperamentTrait,
} from '@doggystyle/shared';
import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { getAiProvider } from '../../ai/index.js';
import type { ProfileExtractionInput } from '../../ai/types.js';
import { db, type DbOrTx } from '../../db/client.js';
import {
  breedingRecords,
  dogProfileAttributeHistory,
  dogProfileAttributes,
  dogProfiles,
  dogs,
  mediaAssets,
  users,
} from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { coarsenLatLng, formatCoarseLabel, geohash, lookupCity } from '../../lib/geo.js';
import { mediaAssetToDto, processPendingAssetsForUser } from '../media/service.js';

/**
 * Dog profiles with per-attribute provenance (ADR 0006).
 *
 * Every fact about a dog flows through `applyAttributeUpdates`, which is the
 * single choke point where:
 *  - sensitive keys are rejected for any non-trusted source (defence in depth
 *    above the DB CHECK constraint in migration 0001),
 *  - values are validated against the shared domain vocabulary,
 *  - provenance + history are recorded,
 *  - confirmed / high-confidence values are projected onto the flat
 *    `dog_profiles` columns that matching reads.
 */

type DogRow = typeof dogs.$inferSelect;
type DogProfileRow = typeof dogProfiles.$inferSelect;
type AttributeRow = typeof dogProfileAttributes.$inferSelect;
type MediaAssetRow = typeof mediaAssets.$inferSelect;
type BreedingRow = typeof breedingRecords.$inferSelect;

export interface AttributeUpdateInput {
  key: string;
  value: unknown;
  confidence?: number;
  userConfirmed?: boolean;
}

/** Model-sourced values project onto profile columns only at/above this confidence. */
const MODEL_PROJECTION_MIN_CONFIDENCE = 0.4;

/** A cluster qualifies as "probably this owner's dog" at/above this average score. */
const MIN_CLUSTER_AVG_DOG_SCORE = 0.35;

const isTrustedSource = (source: string): boolean => (TRUSTED_ATTRIBUTE_SOURCES as readonly string[]).includes(source);

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const clampConfidence = (v: number | undefined, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, Number(v.toFixed(3)))) : fallback;

const round3 = (v: number): number => Number(v.toFixed(3));

/* ─────────────────────────────────────────────────────────────────────────────
 * Per-key value validation
 * ───────────────────────────────────────────────────────────────────────────*/

type Validator = (value: unknown) => unknown;

const enumValidator =
  (allowed: readonly string[], label: string): Validator =>
  (value) => {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw unprocessable(`"${label}" must be one of: ${allowed.join(', ')}.`);
    }
    return value;
  };

/** Arrays are *filtered* to the domain enum (model output degrades gracefully). */
const enumArrayValidator =
  (allowed: readonly string[], label: string): Validator =>
  (value) => {
    if (!Array.isArray(value)) throw unprocessable(`"${label}" must be an array.`);
    return [...new Set(value.filter((v): v is string => typeof v === 'string' && allowed.includes(v)))];
  };

const boolValidator =
  (label: string): Validator =>
  (value) => {
    if (typeof value !== 'boolean') throw unprocessable(`"${label}" must be true or false.`);
    return value;
  };

const numberValidator =
  (min: number, max: number, label: string): Validator =>
  (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw unprocessable(`"${label}" must be a number between ${min} and ${max}.`);
    }
    return Math.round(value * 10) / 10;
  };

const intValidator =
  (min: number, max: number, label: string): Validator =>
  (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw unprocessable(`"${label}" must be a whole number between ${min} and ${max}.`);
    }
    return value;
  };

const textValidator =
  (max: number, label: string): Validator =>
  (value) => {
    if (typeof value !== 'string') throw unprocessable(`"${label}" must be text.`);
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > max) throw unprocessable(`"${label}" must be 1-${max} characters.`);
    return trimmed;
  };

const stringArrayValidator =
  (maxItems: number, maxLength: number, label: string): Validator =>
  (value) => {
    if (!Array.isArray(value)) throw unprocessable(`"${label}" must be an array.`);
    const items = value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v.length <= maxLength);
    if (items.length > maxItems) throw unprocessable(`"${label}" can have at most ${maxItems} entries.`);
    return [...new Set(items)];
  };

const dateValidator =
  (label: string): Validator =>
  (value) => {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw unprocessable(`"${label}" must be an ISO date.`);
    }
    return new Date(value).toISOString();
  };

/** Known breeds are canonicalised; anything else is kept as free text. */
const breedValidator: Validator = (value) => {
  if (typeof value !== 'string') throw unprocessable('"breed" must be text.');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 60) throw unprocessable('"breed" must be 1-60 characters.');
  return findBreed(trimmed)?.name ?? trimmed;
};

/**
 * The full attribute vocabulary: INFERABLE + SENSITIVE keys, plus `restrictions`
 * which is owner-entered only. `city` / `location_precision` are user-level and
 * handled separately in `applyAttributeUpdates`.
 */
const ATTRIBUTE_VALIDATORS: Record<string, Validator> = {
  name: textValidator(40, 'name'),
  breed: breedValidator,
  breed_secondary: breedValidator,
  age_years: numberValidator(0, 30, 'age_years'),
  sex: enumValidator(DOG_SEXES, 'sex'),
  size: enumValidator(DOG_SIZES, 'size'),
  weight_kg: numberValidator(0.5, 120, 'weight_kg'),
  activity_level: enumValidator(ACTIVITY_LEVELS, 'activity_level'),
  sociability: enumValidator(SOCIABILITY, 'sociability'),
  play_styles: enumArrayValidator(PLAY_STYLES, 'play_styles'),
  temperament: enumArrayValidator(TEMPERAMENT_TRAITS, 'temperament'),
  interests: enumArrayValidator(INTERESTS, 'interests'),
  bio: textValidator(400, 'bio'),
  good_with_small_dogs: boolValidator('good_with_small_dogs'),
  good_with_large_dogs: boolValidator('good_with_large_dogs'),
  good_with_puppies: boolValidator('good_with_puppies'),
  good_with_kids: boolValidator('good_with_kids'),
  restrictions: stringArrayValidator(10, 120, 'restrictions'),
  // Sensitive keys — writable only by user / verified_document (checked below).
  reproductive_status: enumValidator(REPRODUCTIVE_STATUSES, 'reproductive_status'),
  health_notes: textValidator(500, 'health_notes'),
  vaccination_status: textValidator(120, 'vaccination_status'),
  genetic_tests: stringArrayValidator(10, 120, 'genetic_tests'),
  health_screenings: stringArrayValidator(10, 120, 'health_screenings'),
  pedigree: textValidator(200, 'pedigree'),
  registration_number: textValidator(60, 'registration_number'),
  litters_whelped: intValidator(0, 20, 'litters_whelped'),
  last_season_date: dateValidator('last_season_date'),
  vet_clearance: textValidator(200, 'vet_clearance'),
};

/* ─────────────────────────────────────────────────────────────────────────────
 * Ownership & lookups
 * ───────────────────────────────────────────────────────────────────────────*/

/**
 * Loads a live dog owned by the actor. Throws notFound (never forbidden) for a
 * missing OR foreign dog, so dog ids cannot be enumerated by other users.
 */
export async function assertDogOwner(dogId: string, actorUserId: string): Promise<DogRow> {
  const [dog] = await db
    .select()
    .from(dogs)
    .where(and(eq(dogs.id, dogId), isNull(dogs.deletedAt)))
    .limit(1);
  if (!dog || dog.ownerId !== actorUserId) throw notFound('Dog not found.');
  return dog;
}

export async function getPrimaryDog(userId: string): Promise<{ dog: DogRow; profile: DogProfileRow } | null> {
  const rows = await db
    .select({ dog: dogs, profile: dogProfiles })
    .from(dogs)
    .innerJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(and(eq(dogs.ownerId, userId), isNull(dogs.deletedAt)))
    .orderBy(desc(dogs.isPrimary), asc(dogs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Projection: attributes → flat profile columns
 * ───────────────────────────────────────────────────────────────────────────*/

/** Column patch for a projectable key. `name` lives on `dogs`; sensitive keys have no column. */
function profileColumnPatch(key: string, value: unknown): Partial<typeof dogProfiles.$inferInsert> | null {
  switch (key) {
    case 'breed':
      return { breed: value as string };
    case 'breed_secondary':
      return { breedSecondary: value as string };
    case 'age_years':
      return { ageYears: value as number };
    case 'sex':
      return { sex: value as string };
    case 'size':
      return { size: value as string };
    case 'weight_kg':
      return { weightKg: value as number };
    case 'activity_level':
      return { activityLevel: value as string };
    case 'sociability':
      return { sociability: value as string };
    case 'play_styles':
      return { playStyles: value as string[] };
    case 'temperament':
      return { temperament: value as string[] };
    case 'interests':
      return { interests: value as string[] };
    case 'bio':
      return { bio: value as string };
    case 'good_with_small_dogs':
      return { goodWithSmallDogs: value as boolean };
    case 'good_with_large_dogs':
      return { goodWithLargeDogs: value as boolean };
    case 'good_with_puppies':
      return { goodWithPuppies: value as boolean };
    case 'good_with_kids':
      return { goodWithKids: value as boolean };
    case 'restrictions':
      return { restrictions: value as string[] };
    default:
      return null;
  }
}

/** Completeness = fraction of the 12 core profile facts that are present. */
async function recomputeCompleteness(tx: DbOrTx, dogId: string): Promise<void> {
  const [dog] = await tx.select().from(dogs).where(eq(dogs.id, dogId)).limit(1);
  const [profile] = await tx.select().from(dogProfiles).where(eq(dogProfiles.dogId, dogId)).limit(1);
  if (!dog || !profile) return;
  const [photo] = await tx
    .select({ id: mediaAssets.id })
    .from(mediaAssets)
    .where(and(eq(mediaAssets.dogId, dogId), isNull(mediaAssets.deletedAt)))
    .limit(1);
  const hasPhoto = Boolean(profile.profilePhotoId) || Boolean(photo);
  const present = [
    Boolean(dog.name),
    Boolean(profile.breed),
    profile.ageYears !== null,
    profile.sex !== 'unknown',
    Boolean(profile.size),
    Boolean(profile.activityLevel),
    Boolean(profile.sociability),
    profile.playStyles.length > 0,
    profile.temperament.length > 0,
    profile.interests.length > 0,
    Boolean(profile.bio),
    hasPhoto,
  ];
  const completeness = Number((present.filter(Boolean).length / present.length).toFixed(2));
  await tx.update(dogProfiles).set({ completeness, updatedAt: new Date() }).where(eq(dogProfiles.dogId, dogId));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * applyAttributeUpdates — the ADR 0006 choke point
 * ───────────────────────────────────────────────────────────────────────────*/

interface PreparedUpdate {
  key: string;
  value: unknown;
  confidence: number;
  userConfirmed: boolean;
  sensitive: boolean;
}

export async function applyAttributeUpdates(args: {
  dogId: string;
  actorUserId: string;
  updates: AttributeUpdateInput[];
  source: AttributeSource;
  requestId?: string;
}): Promise<DogProfileDto> {
  const { dogId, actorUserId, updates, source, requestId } = args;
  await assertDogOwner(dogId, actorUserId);

  // Runtime guard for plain-JS callers; the type already restricts TS callers.
  if (!(ATTRIBUTE_SOURCES as readonly string[]).includes(source)) {
    throw unprocessable('Unknown attribute source.');
  }
  const trustedSource = isTrustedSource(source);

  /* ── Validate everything up front: a bad key/value rejects before any write ── */
  const preparedByKey = new Map<string, PreparedUpdate>(); // dedupe, last wins
  let cityUpdate: NonNullable<ReturnType<typeof lookupCity>> | null = null;
  let precisionUpdate: LocationPrecision | null = null;

  for (const update of updates) {
    const key = update.key;

    // Special user-level keys — never stored as dog attributes.
    if (key === 'city') {
      if (!trustedSource) throw unprocessable('Location can only be set by the owner.');
      if (typeof update.value !== 'string') throw unprocessable('"city" must be text.');
      const match = lookupCity(update.value);
      if (!match) throw unprocessable(`We don't know the city "${update.value.trim().slice(0, 60)}" yet.`);
      cityUpdate = match;
      continue;
    }
    if (key === 'location_precision') {
      if (!trustedSource) throw unprocessable('Location precision can only be set by the owner.');
      if (typeof update.value !== 'string' || !(LOCATION_PRECISIONS as readonly string[]).includes(update.value)) {
        throw unprocessable(`"location_precision" must be one of: ${LOCATION_PRECISIONS.join(', ')}.`);
      }
      precisionUpdate = update.value as LocationPrecision;
      continue;
    }

    const validator = ATTRIBUTE_VALIDATORS[key];
    if (!validator) throw unprocessable(`Unknown attribute "${key.slice(0, 40)}".`);

    const sensitive = isSensitiveAttributeKey(key);
    // ADR 0006, defence in depth above the DB CHECK: a model may never write a
    // sensitive fact, no matter what it claims to have inferred.
    if (sensitive && !trustedSource) {
      throw unprocessable(`"${key}" can only come from the owner or a verified document.`);
    }
    // Non-trusted sources are additionally limited to the inferable vocabulary
    // (this keeps e.g. `restrictions` owner-entered only).
    if (!trustedSource && !(INFERABLE_ATTRIBUTE_KEYS as readonly string[]).includes(key)) {
      throw unprocessable(`"${key}" can only be set by the owner.`);
    }

    preparedByKey.set(key, {
      key,
      value: validator(update.value),
      confidence: clampConfidence(update.confidence, trustedSource ? 1 : 0.5),
      userConfirmed: update.userConfirmed ?? trustedSource,
      sensitive,
    });
  }

  const appliedKeys: string[] = [];
  const skippedKeys: string[] = [];
  const historyReason = source === 'user' ? 'owner_update' : source === 'verified_document' ? 'document_verified' : 'model_inference';

  if (preparedByKey.size > 0 || cityUpdate || precisionUpdate) {
    await db.transaction(async (tx) => {
      const existingRows = await tx.select().from(dogProfileAttributes).where(eq(dogProfileAttributes.dogId, dogId));
      const existingByKey = new Map<string, AttributeRow>(existingRows.map((r) => [r.key, r]));
      const now = new Date();
      const profilePatch: Partial<typeof dogProfiles.$inferInsert> = {};
      let namePatch: string | null = null;

      for (const u of preparedByKey.values()) {
        const existing = existingByKey.get(u.key);

        // A model write never overwrites something the owner stated or confirmed.
        if (!trustedSource && existing && (existing.userConfirmed || isTrustedSource(existing.source))) {
          skippedKeys.push(u.key);
          continue;
        }
        // Identical re-writes produce no history noise.
        if (
          existing &&
          existing.source === source &&
          existing.userConfirmed === u.userConfirmed &&
          sameJson(existing.value, u.value)
        ) {
          continue;
        }

        await tx
          .insert(dogProfileAttributes)
          .values({
            dogId,
            key: u.key,
            value: u.value,
            source,
            confidence: u.confidence,
            userConfirmed: u.userConfirmed,
            sensitive: u.sensitive,
            observedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [dogProfileAttributes.dogId, dogProfileAttributes.key],
            set: {
              value: u.value,
              source,
              confidence: u.confidence,
              userConfirmed: u.userConfirmed,
              sensitive: u.sensitive,
              observedAt: now,
              updatedAt: now,
            },
          });

        await tx.insert(dogProfileAttributeHistory).values({
          dogId,
          key: u.key,
          previousValue: existing?.value ?? null,
          newValue: u.value,
          source,
          changedByUserId: actorUserId,
          reason: historyReason,
        });
        appliedKeys.push(u.key);

        // Project onto the flat columns matching reads: owner-stated/confirmed
        // values always; model values only when reasonably confident.
        const projectable = u.userConfirmed || trustedSource || u.confidence >= MODEL_PROJECTION_MIN_CONFIDENCE;
        if (!projectable) continue;
        if (u.key === 'name') {
          namePatch = u.value as string;
          continue;
        }
        const patch = profileColumnPatch(u.key, u.value);
        if (patch) Object.assign(profilePatch, patch);
      }

      if (namePatch !== null) {
        await tx.update(dogs).set({ name: namePatch, updatedAt: now }).where(eq(dogs.id, dogId));
      }
      if (Object.keys(profilePatch).length > 0) {
        await tx.update(dogProfiles).set({ ...profilePatch, updatedAt: now }).where(eq(dogProfiles.dogId, dogId));
      }

      /* ── User-level special keys ────────────────────────────────────────── */
      if (cityUpdate) {
        // City centroids are already coarse; snap anyway so every stored point
        // sits on the same ~1.1 km grid. Only coarse geo is ever stored here.
        const coarse = coarsenLatLng({ lat: cityUpdate.lat, lng: cityUpdate.lng });
        const hash = geohash(coarse, 5);
        await tx
          .update(users)
          .set({
            city: cityUpdate.city,
            country: cityUpdate.country,
            lat: coarse.lat,
            lng: coarse.lng,
            geohash: hash,
            updatedAt: now,
          })
          .where(eq(users.id, actorUserId));
        // Every profile carries a copy of the owner's coarse geo — keep them in sync.
        const ownedDogIds = (
          await tx
            .select({ id: dogs.id })
            .from(dogs)
            .where(and(eq(dogs.ownerId, actorUserId), isNull(dogs.deletedAt)))
        ).map((r) => r.id);
        if (ownedDogIds.length > 0) {
          await tx
            .update(dogProfiles)
            .set({
              city: cityUpdate.city,
              country: cityUpdate.country,
              lat: coarse.lat,
              lng: coarse.lng,
              geohash: hash,
              updatedAt: now,
            })
            .where(inArray(dogProfiles.dogId, ownedDogIds));
        }
      }
      if (precisionUpdate) {
        await tx.update(users).set({ locationPrecision: precisionUpdate, updatedAt: now }).where(eq(users.id, actorUserId));
      }

      await recomputeCompleteness(tx, dogId);
    });
  }

  if (appliedKeys.length > 0 || skippedKeys.length > 0 || cityUpdate || precisionUpdate) {
    await recordAudit({
      actorUserId,
      action: 'dog.attributes_update',
      targetType: 'dog',
      targetId: dogId,
      summary: `updated ${appliedKeys.length} attribute(s) via ${source}`,
      // Key names only — attribute *values* can be sensitive and stay out of audit.
      after: {
        applied: appliedKeys,
        skipped: skippedKeys,
        ...(cityUpdate ? { city: cityUpdate.city } : {}),
        ...(precisionUpdate ? { locationPrecision: precisionUpdate } : {}),
      },
      requestId: requestId ?? null,
    });
  }

  return getDogProfileDto(dogId, actorUserId);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * DTO assembly
 * ───────────────────────────────────────────────────────────────────────────*/

const BREEDING_CHECKS: ReadonlyArray<{
  label: string;
  present: (row: BreedingRow) => boolean;
  femalesOnly?: boolean;
}> = [
  { label: 'Reproductive status', present: (r) => r.reproductiveStatus !== null },
  { label: 'Registration number', present: (r) => r.registrationNumber !== null },
  { label: 'Pedigree', present: (r) => r.pedigree !== null },
  { label: 'Genetic tests', present: (r) => r.geneticTests.length > 0 },
  { label: 'Health screenings', present: (r) => r.healthScreenings.length > 0 },
  { label: 'Vet clearance', present: (r) => r.vetClearance !== null },
  { label: 'Last season date', present: (r) => r.lastSeasonDate !== null, femalesOnly: true },
  { label: 'Litters whelped', present: (r) => r.littersWhelped !== null },
  { label: 'Available from', present: (r) => r.availableFrom !== null },
];

function breedingInfo(row: BreedingRow, sex: string): BreedingInfoDto {
  const applicable = BREEDING_CHECKS.filter((c) => !c.femalesOnly || sex === 'female');
  const missingFields = applicable.filter((c) => !c.present(row)).map((c) => c.label);
  return {
    reproductiveStatus: row.reproductiveStatus as ReproductiveStatus | null,
    registrationNumber: row.registrationNumber,
    pedigree: row.pedigree,
    geneticTests: row.geneticTests,
    healthScreenings: row.healthScreenings,
    vetClearance: row.vetClearance,
    lastSeasonDate: row.lastSeasonDate?.toISOString() ?? null,
    littersWhelped: row.littersWhelped,
    availableFrom: row.availableFrom?.toISOString() ?? null,
    matingNotes: row.matingNotes,
    completeness: Number(((applicable.length - missingFields.length) / applicable.length).toFixed(2)),
    missingFields,
  };
}

/**
 * Owner-only view of a dog. Location is COARSE (city/country + 5-char geohash)
 * even for the owner, so this DTO can never leak more than the wire contract.
 */
export async function getDogProfileDto(dogId: string, actorUserId: string): Promise<DogProfileDto> {
  const dog = await assertDogOwner(dogId, actorUserId);
  const [profile] = await db.select().from(dogProfiles).where(eq(dogProfiles.dogId, dogId)).limit(1);
  if (!profile) throw notFound('Dog not found.');
  const [owner] = await db
    .select({ locationPrecision: users.locationPrecision })
    .from(users)
    .where(eq(users.id, dog.ownerId))
    .limit(1);

  const attrRows = await db.select().from(dogProfileAttributes).where(eq(dogProfileAttributes.dogId, dogId));

  /* ── Photos: assigned to this dog, or unassigned but in the profile-photo cluster ── */
  let profileClusterId: string | null = null;
  if (profile.profilePhotoId) {
    const [pp] = await db
      .select({ clusterId: mediaAssets.clusterId })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, profile.profilePhotoId))
      .limit(1);
    profileClusterId = pp?.clusterId ?? null;
  }
  const clusterFilter = profileClusterId
    ? and(isNull(mediaAssets.dogId), eq(mediaAssets.clusterId, profileClusterId))
    : undefined;
  const photoRows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.userId, dog.ownerId),
        isNull(mediaAssets.deletedAt),
        eq(mediaAssets.status, 'processed'),
        or(eq(mediaAssets.dogId, dogId), clusterFilter),
      ),
    );
  // Sorted in JS: SQL DESC puts NULL quality scores first in Postgres.
  photoRows.sort(
    (a, b) => Number(b.isProfilePhoto) - Number(a.isProfilePhoto) || (b.qualityScore ?? -1) - (a.qualityScore ?? -1),
  );
  const photos = photoRows.slice(0, 30).map((row) => mediaAssetToDto(row));

  /* ── Provenance map ─────────────────────────────────────────────────────── */
  const attributes: Record<string, AttributeProvenance> = {};
  const unconfirmedKeys: string[] = [];
  for (const row of attrRows) {
    attributes[row.key] = {
      value: row.value,
      source: row.source as AttributeSource,
      confidence: row.confidence,
      userConfirmed: row.userConfirmed,
      updatedAt: row.updatedAt.toISOString(),
    };
    if (!row.userConfirmed && !isTrustedSource(row.source)) unconfirmedKeys.push(row.key);
  }

  const [breedingRow] = await db.select().from(breedingRecords).where(eq(breedingRecords.dogId, dogId)).limit(1);

  const ageYears = profile.ageYears;
  // The fractional part of age expressed in months ("2.5 years" → 2y + 6m).
  const ageMonths = ageYears === null ? null : Math.round((ageYears - Math.floor(ageYears)) * 12) % 12;

  const profilePhoto = photos.find((p) => p.isProfilePhoto) ?? null;

  return {
    id: dog.id,
    name: dog.name,
    breed: profile.breed,
    breedSecondary: profile.breedSecondary,
    ageYears,
    ageMonths,
    sex: (profile.sex as DogSex) ?? 'unknown',
    size: profile.size as DogSize | null,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel as ActivityLevel | null,
    sociability: profile.sociability as Sociability | null,
    playStyles: profile.playStyles as PlayStyle[],
    temperament: profile.temperament as TemperamentTrait[],
    interests: profile.interests as Interest[],
    bio: profile.bio,
    goodWithSmallDogs: profile.goodWithSmallDogs,
    goodWithLargeDogs: profile.goodWithLargeDogs,
    goodWithPuppies: profile.goodWithPuppies,
    goodWithKids: profile.goodWithKids,
    restrictions: profile.restrictions,
    visibility: profile.visibility as ProfileVisibility,
    // Coarse only: city/country + geohash clipped to 5 chars. Never lat/lng.
    location: {
      label: formatCoarseLabel(profile.city, profile.country),
      city: profile.city,
      country: profile.country,
      geohash: profile.geohash ? profile.geohash.slice(0, 5) : null,
      precision: (owner?.locationPrecision as LocationPrecision) ?? 'city',
    },
    photos,
    profilePhotoUrl: profilePhoto?.url ?? photos[0]?.url ?? null,
    attributes,
    unconfirmedKeys,
    breeding: breedingRow ? breedingInfo(breedingRow, profile.sex) : null,
    completeness: profile.completeness,
    createdAt: dog.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * createDogWithProfile
 * ───────────────────────────────────────────────────────────────────────────*/

export async function createDogWithProfile(userId: string, init?: { name?: string }): Promise<string> {
  const [owner] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!owner) throw notFound('User not found.');

  const name = init?.name ? (ATTRIBUTE_VALIDATORS['name']!(init.name) as string) : null;

  const dogId = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: dogs.id })
      .from(dogs)
      .where(and(eq(dogs.ownerId, userId), isNull(dogs.deletedAt)))
      .limit(1);
    const [dog] = await tx
      .insert(dogs)
      .values({ ownerId: userId, name, isPrimary: !existing })
      .returning({ id: dogs.id });

    // The profile copies the owner's *coarse* geo (users.lat/lng are already
    // grid-snapped) so geo filtering never joins back to users.
    await tx.insert(dogProfiles).values({
      dogId: dog!.id,
      city: owner.city,
      country: owner.country,
      lat: owner.lat,
      lng: owner.lng,
      geohash: owner.geohash,
    });

    // A name given at creation is an owner statement — record its provenance.
    if (name) {
      const now = new Date();
      await tx.insert(dogProfileAttributes).values({
        dogId: dog!.id,
        key: 'name',
        value: name,
        source: 'user',
        confidence: 1,
        userConfirmed: true,
        sensitive: false,
        observedAt: now,
        updatedAt: now,
      });
      await tx.insert(dogProfileAttributeHistory).values({
        dogId: dog!.id,
        key: 'name',
        previousValue: null,
        newValue: name,
        source: 'user',
        changedByUserId: userId,
        reason: 'owner_update',
      });
    }
    return dog!.id;
  });

  await recordAudit({
    actorUserId: userId,
    action: 'dog.create',
    targetType: 'dog',
    targetId: dogId,
    summary: name ? `created dog "${name}"` : 'created dog',
  });

  return dogId;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * confirmAttributes
 * ───────────────────────────────────────────────────────────────────────────*/

export async function confirmAttributes(args: {
  dogId: string;
  actorUserId: string;
  keys: string[];
  requestId?: string;
}): Promise<DogProfileDto> {
  const { dogId, actorUserId, keys, requestId } = args;
  await assertDogOwner(dogId, actorUserId);

  const wanted = [...new Set(keys)].filter((k) => k in ATTRIBUTE_VALIDATORS);
  const confirmed: string[] = [];

  if (wanted.length > 0) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(dogProfileAttributes)
        .where(and(eq(dogProfileAttributes.dogId, dogId), inArray(dogProfileAttributes.key, wanted)));
      const now = new Date();
      const profilePatch: Partial<typeof dogProfiles.$inferInsert> = {};
      let namePatch: string | null = null;

      for (const row of rows) {
        if (row.userConfirmed) continue; // already confirmed — nothing to record
        await tx
          .update(dogProfileAttributes)
          // Source stays as-is: provenance records where the value *came from*.
          .set({ userConfirmed: true, confidence: 1, updatedAt: now })
          .where(eq(dogProfileAttributes.id, row.id));
        await tx.insert(dogProfileAttributeHistory).values({
          dogId,
          key: row.key,
          previousValue: row.value,
          newValue: row.value,
          source: row.source,
          changedByUserId: actorUserId,
          reason: 'owner_confirmed',
        });
        confirmed.push(row.key);

        // Confirmation makes the value trustworthy — project it even if the
        // model was originally below the projection threshold.
        if (row.key === 'name') namePatch = row.value as string;
        else {
          const patch = profileColumnPatch(row.key, row.value);
          if (patch) Object.assign(profilePatch, patch);
        }
      }

      if (namePatch !== null) await tx.update(dogs).set({ name: namePatch, updatedAt: now }).where(eq(dogs.id, dogId));
      if (Object.keys(profilePatch).length > 0) {
        await tx.update(dogProfiles).set({ ...profilePatch, updatedAt: now }).where(eq(dogProfiles.dogId, dogId));
      }
      await recomputeCompleteness(tx, dogId);
    });
  }

  if (confirmed.length > 0) {
    await recordAudit({
      actorUserId,
      action: 'dog.attributes_confirm',
      targetType: 'dog',
      targetId: dogId,
      summary: `confirmed ${confirmed.join(', ')}`,
      requestId: requestId ?? null,
    });
  }

  return getDogProfileDto(dogId, actorUserId);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * generateProfileFromMedia
 * ───────────────────────────────────────────────────────────────────────────*/

/** Signature histogram layout — must match ai/heuristic/media.ts. */
const SIG_HUE_BINS = 12;
const SIG_SAT_BINS = 3;
const SIG_VAL_BINS = 3;
/** Mirrors the outdoor threshold in ai/heuristic/media.ts. */
const OUTDOOR_SHARE_THRESHOLD = 0.22;

/**
 * Derive brightness/saturation/outdoor-ness estimates from the stored HSV
 * histogram — per-image feature columns are not persisted, but the histogram
 * carries enough signal for aggregate statistics.
 */
function signatureStats(signature: number[]): { brightness: number; saturation: number; outdoorish: number } {
  if (signature.length !== SIG_HUE_BINS * SIG_SAT_BINS * SIG_VAL_BINS) {
    return { brightness: 0.5, saturation: 0.5, outdoorish: 0 };
  }
  let brightness = 0;
  let saturation = 0;
  let outdoorish = 0;
  for (let hb = 0; hb < SIG_HUE_BINS; hb += 1) {
    for (let sb = 0; sb < SIG_SAT_BINS; sb += 1) {
      for (let vb = 0; vb < SIG_VAL_BINS; vb += 1) {
        const w = signature[hb * SIG_SAT_BINS * SIG_VAL_BINS + sb * SIG_VAL_BINS + vb] ?? 0;
        brightness += w * ((vb + 0.5) / SIG_VAL_BINS);
        saturation += w * ((sb + 0.5) / SIG_SAT_BINS);
        // Hue bins 2..8 ≈ 60°..270° — vegetation greens and sky blues.
        if (hb >= 2 && hb <= 8 && sb >= 1) outdoorish += w;
      }
    }
  }
  return { brightness, saturation, outdoorish };
}

/** Largest cluster whose average dog score clears the bar. */
function pickLargestDogCluster(rows: MediaAssetRow[]): MediaAssetRow[] {
  const byCluster = new Map<string, MediaAssetRow[]>();
  for (const row of rows) {
    if (!row.clusterId) continue;
    const group = byCluster.get(row.clusterId) ?? [];
    group.push(row);
    byCluster.set(row.clusterId, group);
  }
  let best: MediaAssetRow[] = [];
  for (const group of byCluster.values()) {
    const avg = group.reduce((s, r) => s + (r.dogScore ?? 0), 0) / group.length;
    if (avg < MIN_CLUSTER_AVG_DOG_SCORE) continue;
    if (group.length > best.length) best = group;
  }
  return best;
}

export async function generateProfileFromMedia(args: {
  userId: string;
  dogId?: string;
  clusterId?: string;
  requestId?: string;
}): Promise<DogProfileDto> {
  const { userId, clusterId, requestId } = args;

  // Fold in any freshly uploaded photos so "generate" sees everything (idempotent).
  await processPendingAssetsForUser(userId);

  /* ── Resolve or create the dog ──────────────────────────────────────────── */
  let dogRow: DogRow;
  if (args.dogId) {
    dogRow = await assertDogOwner(args.dogId, userId);
  } else {
    const primary = await getPrimaryDog(userId);
    if (primary) {
      dogRow = primary.dog;
    } else {
      const createdId = await createDogWithProfile(userId);
      const [created] = await db.select().from(dogs).where(eq(dogs.id, createdId)).limit(1);
      if (!created) throw notFound('Dog not found.');
      dogRow = created;
    }
  }

  /* ── Candidate media: processed, live, unassigned or already this dog's ─── */
  const mediaRows = await db
    .select()
    .from(mediaAssets)
    .where(
      and(
        eq(mediaAssets.userId, userId),
        eq(mediaAssets.status, 'processed'),
        isNull(mediaAssets.deletedAt),
        or(isNull(mediaAssets.dogId), eq(mediaAssets.dogId, dogRow.id)),
      ),
    );

  let selected: MediaAssetRow[];
  if (clusterId) {
    selected = mediaRows.filter((r) => r.clusterId === clusterId);
    if (selected.length === 0) throw notFound('No photos found in that group.');
  } else {
    selected = pickLargestDogCluster(mediaRows);
    if (selected.length === 0) {
      throw unprocessable('No suitable dog photos yet. Upload or import a few photos first.');
    }
  }
  // Cap the working set so aggregates stay cheap on very large imports.
  selected = [...selected].sort((a, b) => (b.qualityScore ?? -1) - (a.qualityScore ?? -1)).slice(0, 60);

  /* ── Build the extraction input (aggregates + captions, never pixels) ───── */
  const captions = selected
    .map((r) => r.caption?.trim())
    .filter((c): c is string => Boolean(c))
    .slice(0, 50)
    .map((c) => c.slice(0, 500));

  // Sensitive attribute values never enter a model prompt.
  const knownAttributes: Record<string, unknown> = {};
  const attrRows = await db.select().from(dogProfileAttributes).where(eq(dogProfileAttributes.dogId, dogRow.id));
  for (const row of attrRows) {
    if (!row.sensitive) knownAttributes[row.key] = row.value;
  }

  const stats = selected.map((r) => signatureStats(r.signature ?? []));
  const avg = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0.5);
  const input: ProfileExtractionInput = {
    captions,
    ownerNotes: [],
    mediaFeatures: {
      photoCount: selected.length,
      averageBrightness: round3(avg(stats.map((s) => s.brightness))),
      averageSaturation: round3(avg(stats.map((s) => s.saturation))),
      dominantHues: [], // hue reconstruction from stored histograms is not reliable enough yet
      // Per-image subject fill is not persisted; dogScore is the closest stored proxy.
      subjectFill: round3(avg(selected.map((r) => r.dogScore ?? 0.5))),
      outdoorRatio: round3(
        stats.length ? stats.filter((s) => s.outdoorish > OUTDOOR_SHARE_THRESHOLD).length / stats.length : 0,
      ),
      motionRatio: 0, // real motion detection is future work
    },
    knownAttributes,
  };

  const extraction = await getAiProvider().extractProfile(input);

  /* ── Convert extraction → attribute update batches ──────────────────────── */
  // Candidates are pre-validated here so one piece of model junk drops silently
  // instead of failing the whole generation.
  const candidates = new Map<string, { value: unknown; confidence: number }>();
  const addCandidate = (key: string, value: unknown, confidence: number): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (isSensitiveAttributeKey(key)) return; // extraction cannot emit these — drop defensively
    if (!(INFERABLE_ATTRIBUTE_KEYS as readonly string[]).includes(key)) return;
    const validator = ATTRIBUTE_VALIDATORS[key];
    if (!validator) return;
    try {
      candidates.set(key, { value: validator(value), confidence: clampConfidence(confidence, 0.5) });
    } catch {
      // Invalid model output for this key — ignore it.
    }
  };
  addCandidate('name', extraction.name, 0.5);
  addCandidate('breed', extraction.breed, 0.5);
  addCandidate('breed_secondary', extraction.breedSecondary, 0.5);
  addCandidate('age_years', extraction.ageYears, 0.4);
  if (extraction.sex !== 'unknown') addCandidate('sex', extraction.sex, 0.4);
  addCandidate('size', extraction.size, 0.4);
  addCandidate('activity_level', extraction.activityLevel, 0.4);
  addCandidate('sociability', extraction.sociability, 0.4);
  addCandidate('play_styles', extraction.playStyles, 0.5);
  addCandidate('temperament', extraction.temperament, 0.5);
  addCandidate('interests', extraction.interests, 0.5);
  addCandidate('bio', extraction.bio, 0.5);
  // The candidate list wins over the typed top-level fields — it carries confidence.
  for (const c of extraction.attributes) addCandidate(c.key, c.value, c.confidence);

  // Visually-derived keys are attributed to the vision model; the rest to text.
  const VISION_KEYS = new Set(['breed', 'breed_secondary', 'size', 'weight_kg', 'age_years', 'sex', 'activity_level']);
  const visionBatch: AttributeUpdateInput[] = [];
  const textBatch: AttributeUpdateInput[] = [];
  for (const [key, c] of candidates) {
    (VISION_KEYS.has(key) ? visionBatch : textBatch).push({ key, value: c.value, confidence: c.confidence });
  }

  /* ── Attach the media to the dog & pick a profile photo ─────────────────── */
  const selectedIds = selected.map((r) => r.id);
  const best = selected[0]!; // already sorted by qualityScore desc
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(mediaAssets).set({ dogId: dogRow.id, updatedAt: now }).where(inArray(mediaAssets.id, selectedIds));
    // Exactly one profile photo per dog; other dogs' flags are untouched.
    await tx
      .update(mediaAssets)
      .set({ isProfilePhoto: false, updatedAt: now })
      .where(and(eq(mediaAssets.dogId, dogRow.id), eq(mediaAssets.isProfilePhoto, true), ne(mediaAssets.id, best.id)));
    await tx.update(mediaAssets).set({ isProfilePhoto: true, updatedAt: now }).where(eq(mediaAssets.id, best.id));
    await tx.update(dogProfiles).set({ profilePhotoId: best.id, updatedAt: now }).where(eq(dogProfiles.dogId, dogRow.id));
  });

  /* ── Apply the batches (photo first, so completeness sees it) ───────────── */
  if (visionBatch.length > 0) {
    await applyAttributeUpdates({ dogId: dogRow.id, actorUserId: userId, updates: visionBatch, source: 'vision_model', requestId });
  }
  if (textBatch.length > 0) {
    await applyAttributeUpdates({ dogId: dogRow.id, actorUserId: userId, updates: textBatch, source: 'text_model', requestId });
  }
  if (visionBatch.length === 0 && textBatch.length === 0) {
    // Nothing inferable, but the photo assignment still changes completeness.
    await recomputeCompleteness(db, dogRow.id);
  }

  await recordAudit({
    actorUserId: userId,
    action: 'dog.profile_generated',
    targetType: 'dog',
    targetId: dogRow.id,
    summary: `generated profile from ${selected.length} photo(s)`,
    after: {
      photoCount: selected.length,
      clusterId: best.clusterId ?? null,
      attributeKeys: [...candidates.keys()],
    },
    requestId: requestId ?? null,
  });

  return getDogProfileDto(dogRow.id, userId);
}
