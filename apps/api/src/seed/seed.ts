import { and, eq, isNull } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  availability,
  breedingRecords,
  connections,
  consentEvents,
  conversations,
  dogConnections,
  dogProfileAttributes,
  dogProfiles,
  dogs,
  matchRequests,
  mediaAssets,
  meetupParticipants,
  meetups,
  messages,
  preferences,
  users,
} from '../db/schema.js';
import { hashPassword } from '../lib/crypto.js';
import { coarsenLatLng, geohash, lookupCity, midpoint } from '../lib/geo.js';
import { logger } from '../lib/logger.js';
import { ingestImageBuffer, processPendingAssetsForUser } from '../modules/media/service.js';
import { DEMO_EMAIL_DOMAIN, DEMO_PASSWORD, SEED_CONVERSATION, SEED_OWNERS, type SeedOwner } from './data.js';
import { dogPhoto, nonDogPhoto } from './images.js';

export interface SeedResult {
  skipped?: true;
  users?: number;
  dogs?: number;
  photos?: number;
}

/**
 * Idempotent by marker: if the admin account exists we assume the seed already
 * ran. `force` is for `npm run db:reset`, which drops the schema first anyway.
 */
export async function runSeed(opts: { force: boolean } = { force: false }): Promise<SeedResult> {
  const [existingAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.emailNormalized, env.ADMIN_EMAIL.trim().toLowerCase()))
    .limit(1);

  if (existingAdmin && !opts.force) return { skipped: true };

  logger.info('seeding demo data…');

  // scrypt is intentionally slow — hash once and reuse for every demo owner.
  const [adminHash, demoHash] = await Promise.all([hashPassword(env.ADMIN_PASSWORD), hashPassword(DEMO_PASSWORD)]);
  const now = new Date();

  let userCount = 0;
  let dogCount = 0;
  let photoCount = 0;

  if (!existingAdmin) {
    const tlv = lookupCity('Tel Aviv')!;
    const coarse = coarsenLatLng({ lat: tlv.lat, lng: tlv.lng });
    await db.insert(users).values({
      email: env.ADMIN_EMAIL,
      emailNormalized: env.ADMIN_EMAIL.trim().toLowerCase(),
      passwordHash: adminHash,
      displayName: 'Doggystyle Admin',
      role: 'admin',
      status: 'active',
      city: tlv.city,
      country: tlv.country,
      lat: coarse.lat,
      lng: coarse.lng,
      geohash: geohash(coarse),
      ageAttestedAt: now,
      emailVerifiedAt: now,
    });
    userCount += 1;
  }

  const created: Array<{ owner: SeedOwner; userId: string; dogId: string }> = [];

  for (const [index, owner] of SEED_OWNERS.entries()) {
    try {
      const email = `${owner.slug}@${DEMO_EMAIL_DOMAIN}`;
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.emailNormalized, email))
        .limit(1);
      if (existing) continue;

      const city = lookupCity(owner.city);
      // Deterministic jitter so owners are near, but not on top of, each other.
      const jitter = ((index % 5) + 1) * 0.004 * (index % 2 === 0 ? 1 : -1);
      const point = city ? coarsenLatLng({ lat: city.lat + jitter, lng: city.lng + jitter / 2 }) : null;

      const [user] = await db
        .insert(users)
        .values({
          email,
          emailNormalized: email,
          passwordHash: demoHash,
          displayName: owner.displayName,
          role: 'user',
          status: 'active',
          city: city?.city ?? owner.city,
          country: city?.country ?? null,
          lat: point?.lat ?? null,
          lng: point?.lng ?? null,
          geohash: point ? geohash(point) : null,
          ageAttestedAt: now,
          emailVerifiedAt: now,
        })
        .returning({ id: users.id });
      const userId = user!.id;
      userCount += 1;

      await db.insert(consentEvents).values([
        { userId, kind: 'terms', granted: true, version: '1' },
        { userId, kind: 'age_18', granted: true, version: '1' },
      ]);

      const d = owner.dog;
      const [dog] = await db
        .insert(dogs)
        .values({ ownerId: userId, name: d.name, status: 'active', isPrimary: true })
        .returning({ id: dogs.id });
      const dogId = dog!.id;
      dogCount += 1;

      await db.insert(dogProfiles).values({
        dogId,
        breed: d.breed,
        ageYears: d.ageYears,
        sex: d.sex,
        size: d.size,
        weightKg: d.weightKg,
        activityLevel: d.activityLevel,
        sociability: d.sociability,
        playStyles: d.playStyles,
        temperament: d.temperament,
        interests: d.interests,
        bio: d.bio,
        goodWithSmallDogs: d.goodWithSmallDogs,
        goodWithLargeDogs: d.goodWithLargeDogs,
        goodWithPuppies: d.goodWithPuppies,
        goodWithKids: d.goodWithKids,
        visibility: 'public',
        city: city?.city ?? owner.city,
        country: city?.country ?? null,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        geohash: point ? geohash(point) : null,
        completeness: 0.95,
      });

      // Seeded dogs are owner-confirmed: their data is ground truth, not inference.
      const attrs: Array<{ key: string; value: unknown }> = [
        { key: 'name', value: d.name },
        { key: 'breed', value: d.breed },
        { key: 'age_years', value: d.ageYears },
        { key: 'sex', value: d.sex },
        { key: 'size', value: d.size },
        { key: 'weight_kg', value: d.weightKg },
        { key: 'activity_level', value: d.activityLevel },
        { key: 'sociability', value: d.sociability },
        { key: 'play_styles', value: d.playStyles },
        { key: 'temperament', value: d.temperament },
        { key: 'interests', value: d.interests },
        { key: 'bio', value: d.bio },
        { key: 'good_with_small_dogs', value: d.goodWithSmallDogs },
        { key: 'good_with_large_dogs', value: d.goodWithLargeDogs },
        { key: 'good_with_puppies', value: d.goodWithPuppies },
        { key: 'good_with_kids', value: d.goodWithKids },
      ];
      await db.insert(dogProfileAttributes).values(
        attrs.map((a) => ({
          dogId,
          key: a.key,
          value: a.value as never,
          source: 'user' as const,
          confidence: 1,
          userConfirmed: true,
          sensitive: false,
        })),
      );

      await db.insert(preferences).values({
        userId,
        dogId,
        radiusKm: owner.radiusKm,
        intents: owner.intents,
      });

      if (owner.availability.length) {
        await db
          .insert(availability)
          .values(owner.availability.map((slot) => ({ userId, dogId, weekday: slot.weekday, daypart: slot.daypart })));
      }

      if (owner.breeding) {
        const b = owner.breeding;
        await db.insert(breedingRecords).values({
          dogId,
          reproductiveStatus: b.reproductiveStatus,
          registrationNumber: b.registrationNumber ?? null,
          pedigree: b.pedigree ?? null,
          geneticTests: b.geneticTests ?? [],
          healthScreenings: b.healthScreenings ?? [],
          vetClearance: b.vetClearance ?? null,
          littersWhelped: b.littersWhelped ?? null,
          matingNotes: b.matingNotes ?? null,
          availableFrom: b.availableFromDaysAgo
            ? new Date(now.getTime() - b.availableFromDaysAgo * 24 * 3600 * 1000)
            : null,
        });
        // Reproductive status is a sensitive key: only ever source 'user'.
        await db.insert(dogProfileAttributes).values({
          dogId,
          key: 'reproductive_status',
          value: b.reproductiveStatus as never,
          source: 'user',
          confidence: 1,
          userConfirmed: true,
          sensitive: true,
        });
      }

      // Photos: 3 dog shots + 1 obvious non-dog so the pipeline has to discriminate.
      const seed = `${owner.slug}-${d.name}`;
      const captions = [
        `Morning zoomies with ${d.name}`,
        `${d.name} at the park — our ${d.breed.toLowerCase()}`,
        `${d.name} loves the beach`,
      ];
      for (let v = 0; v < 3; v += 1) {
        const buffer = await dogPhoto(seed, v);
        const result = await ingestImageBuffer({
          userId,
          buffer,
          mimeType: 'image/jpeg',
          caption: captions[v] ?? null,
          provider: 'demo',
        });
        if (result.assetId && !result.duplicate) photoCount += 1;
      }
      await ingestImageBuffer({
        userId,
        buffer: await nonDogPhoto(seed, index),
        mimeType: 'image/jpeg',
        caption: 'City skyline',
        provider: 'demo',
      });

      await processPendingAssetsForUser(userId);

      // Attach the accepted photos to this dog and pick a profile picture.
      const assets = await db
        .select({ id: mediaAssets.id, quality: mediaAssets.qualityScore, status: mediaAssets.status })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.userId, userId), isNull(mediaAssets.deletedAt)));

      const usable = assets.filter((a) => a.status === 'processed').sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0));
      if (usable.length) {
        await db
          .update(mediaAssets)
          .set({ dogId })
          .where(and(eq(mediaAssets.userId, userId), isNull(mediaAssets.deletedAt)));
        await db.update(mediaAssets).set({ isProfilePhoto: true }).where(eq(mediaAssets.id, usable[0]!.id));
        await db.update(dogProfiles).set({ profilePhotoId: usable[0]!.id }).where(eq(dogProfiles.dogId, dogId));
      }

      created.push({ owner, userId, dogId });
    } catch (err) {
      // One bad owner must not abort the whole seed.
      logger.error({ err, owner: owner.slug }, 'seed: owner failed');
    }
  }

  /* ── A pre-existing friendship, so the app never looks empty ───────────── */
  try {
    const lior = created.find((c) => c.owner.slug === 'owner9');
    const michal = created.find((c) => c.owner.slug === 'owner10');

    if (lior && michal) {
      const [request] = await db
        .insert(matchRequests)
        .values({
          fromUserId: lior.userId,
          toUserId: michal.userId,
          fromDogId: lior.dogId,
          toDogId: michal.dogId,
          intent: 'playdate',
          reasons: ['Similar activity level', 'Both enjoy long outdoor walks', 'Owners are usually free Saturday mornings'],
          status: 'accepted',
          respondedAt: new Date(now.getTime() - 20 * 24 * 3600 * 1000),
        })
        .returning({ id: matchRequests.id });

      const pair =
        lior.userId < michal.userId
          ? { userAId: lior.userId, dogAId: lior.dogId, userBId: michal.userId, dogBId: michal.dogId }
          : { userAId: michal.userId, dogAId: michal.dogId, userBId: lior.userId, dogBId: lior.dogId };

      const [connection] = await db
        .insert(connections)
        .values({ ...pair, matchRequestId: request!.id, intent: 'playdate', status: 'active' })
        .returning({ id: connections.id });

      const [conversation] = await db
        .insert(conversations)
        .values({ connectionId: connection!.id, lastMessageAt: now })
        .returning({ id: conversations.id });

      await db.insert(messages).values(
        SEED_CONVERSATION.map((body, i) => ({
          conversationId: conversation!.id,
          senderUserId: i % 2 === 0 ? lior.userId : michal.userId,
          kind: 'text' as const,
          body,
          readAt: now,
          createdAt: new Date(now.getTime() - (SEED_CONVERSATION.length - i) * 3600 * 1000),
        })),
      );

      const dogPair =
        lior.dogId < michal.dogId ? { a: lior.dogId, b: michal.dogId } : { a: michal.dogId, b: lior.dogId };
      await db.insert(dogConnections).values({
        dogAId: dogPair.a,
        dogBId: dogPair.b,
        meetCount: 2,
        lastMetAt: new Date(now.getTime() - 14 * 24 * 3600 * 1000),
        rapport: 0.8,
        wantsAgain: true,
      });

      // Next Saturday 09:00 local.
      const start = new Date(now);
      start.setHours(9, 0, 0, 0);
      start.setDate(start.getDate() + ((6 - start.getDay() + 7) % 7 || 7));

      const [pointA] = await db.select({ lat: users.lat, lng: users.lng }).from(users).where(eq(users.id, lior.userId));
      const [pointB] = await db.select({ lat: users.lat, lng: users.lng }).from(users).where(eq(users.id, michal.userId));
      const mid =
        pointA?.lat != null && pointA.lng != null && pointB?.lat != null && pointB.lng != null
          ? midpoint({ lat: pointA.lat, lng: pointA.lng }, { lat: pointB.lat, lng: pointB.lng })
          : null;

      const [meetup] = await db
        .insert(meetups)
        .values({
          connectionId: connection!.id,
          proposedByUserId: lior.userId,
          intent: 'playdate',
          title: 'Playdate with Bamba',
          status: 'accepted',
          startsAt: start,
          endsAt: new Date(start.getTime() + 90 * 60 * 1000),
          locationLabel: 'Tel Aviv — a public park or open meeting spot',
          locationNote: 'North end of the park, by the water fountain.',
          lat: mid?.lat ?? null,
          lng: mid?.lng ?? null,
        })
        .returning({ id: meetups.id });

      await db.insert(meetupParticipants).values([
        { meetupId: meetup!.id, userId: lior.userId, dogId: lior.dogId, response: 'accepted', respondedAt: now },
        { meetupId: meetup!.id, userId: michal.userId, dogId: michal.dogId, response: 'accepted', respondedAt: now },
      ]);
    }
  } catch (err) {
    logger.error({ err }, 'seed: sample connection failed');
  }

  const result: SeedResult = { users: userCount, dogs: dogCount, photos: photoCount };
  logger.info(result, 'seed complete');
  return result;
}
