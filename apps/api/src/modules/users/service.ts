import { eq, inArray, isNull, or, and } from 'drizzle-orm';
import type { LocationPrecision, ViewerDto } from '@doggystyle/shared';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  availability,
  breedingRecords,
  connections,
  consentEvents,
  dogProfileAttributes,
  dogProfiles,
  dogs,
  matchRequests,
  mediaAssets,
  meetupParticipants,
  meetups,
  messages,
  preferences,
  reports,
  searches,
  users,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { formatCoarseLabel } from '../../lib/geo.js';

/* ── Viewer DTO ──────────────────────────────────────────────────────────── */

/**
 * The signed-in user's own view of their account. This DTO is only ever sent
 * to its subject — it carries the email, but still only COARSE location
 * (label/city/country/5-char geohash), never raw coordinates.
 */
export async function viewerDto(userId: string): Promise<ViewerDto> {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (!user) throw notFound();

  const [dog] = await db
    .select({ id: dogs.id })
    .from(dogs)
    .where(and(eq(dogs.ownerId, userId), isNull(dogs.deletedAt)))
    .limit(1);

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role === 'admin' ? 'admin' : 'user',
    createdAt: user.createdAt.toISOString(),
    location: {
      label: formatCoarseLabel(user.city, user.country),
      city: user.city,
      country: user.country,
      // Defensive slice: nothing finer than a 5-char cell ever crosses the wire.
      geohash: user.geohash ? user.geohash.slice(0, 5) : null,
      precision: (user.locationPrecision as LocationPrecision) ?? 'city',
    },
    hasDog: Boolean(dog),
    demoMode: env.DEMO_MODE,
  };
}

/* ── DSAR export ─────────────────────────────────────────────────────────── */

/**
 * Faithful data-subject export: everything the system stores about this user,
 * minus credential material. Served only to the authenticated account owner,
 * so it may include fields (email, coarse and exact coordinates) that are
 * banned from every peer-visible DTO.
 */
export async function exportUserData(userId: string): Promise<Record<string, unknown>> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw notFound();

  // Exclude only the password hash — tokens live in other tables and are not exported.
  const { passwordHash: _passwordHash, ...account } = user;

  // Dogs first: the dependent tables are keyed by dogId.
  const dogRows = await db.select().from(dogs).where(eq(dogs.ownerId, userId));
  const dogIds = dogRows.map((d) => d.id);
  const [profileRows, attributeRows, breedingRows] =
    dogIds.length > 0
      ? await Promise.all([
          db.select().from(dogProfiles).where(inArray(dogProfiles.dogId, dogIds)),
          db.select().from(dogProfileAttributes).where(inArray(dogProfileAttributes.dogId, dogIds)),
          db.select().from(breedingRecords).where(inArray(breedingRecords.dogId, dogIds)),
        ])
      : [[], [], []];

  const [
    mediaRows,
    preferenceRows,
    availabilityRows,
    searchRows,
    introductionRows,
    connectionRows,
    messageRows,
    meetupRows,
    consentRows,
    reportRows,
  ] = await Promise.all([
    db.select().from(mediaAssets).where(eq(mediaAssets.userId, userId)),
    db.select().from(preferences).where(eq(preferences.userId, userId)),
    db.select().from(availability).where(eq(availability.userId, userId)),
    db.select().from(searches).where(eq(searches.userId, userId)),
    db
      .select()
      .from(matchRequests)
      .where(or(eq(matchRequests.fromUserId, userId), eq(matchRequests.toUserId, userId))),
    db
      .select()
      .from(connections)
      .where(or(eq(connections.userAId, userId), eq(connections.userBId, userId))),
    // Only messages this user authored — peers' messages are their data, not ours to hand over.
    db.select().from(messages).where(eq(messages.senderUserId, userId)),
    db
      .select()
      .from(meetups)
      .where(
        or(
          eq(meetups.proposedByUserId, userId),
          inArray(
            meetups.id,
            db
              .select({ id: meetupParticipants.meetupId })
              .from(meetupParticipants)
              .where(eq(meetupParticipants.userId, userId)),
          ),
        ),
      ),
    db.select().from(consentEvents).where(eq(consentEvents.userId, userId)),
    db.select().from(reports).where(eq(reports.reporterUserId, userId)),
  ]);

  return {
    format: 'doggystyle-export/1',
    exportedAt: new Date().toISOString(),
    account,
    dogs: dogRows.map((dog) => ({
      ...dog,
      profile: profileRows.find((p) => p.dogId === dog.id) ?? null,
      attributes: attributeRows.filter((a) => a.dogId === dog.id),
      breeding: breedingRows.find((b) => b.dogId === dog.id) ?? null,
    })),
    // Metadata only — the binaries stay behind the authenticated media routes.
    media: mediaRows.map(({ storageKey: _storageKey, thumbKey: _thumbKey, ...meta }) => meta),
    preferences: preferenceRows,
    availability: availabilityRows,
    searches: searchRows,
    introductions: introductionRows.map((r) => ({
      ...r,
      direction: r.fromUserId === userId ? 'outgoing' : 'incoming',
    })),
    connections: connectionRows,
    messagesAuthored: messageRows,
    meetups: meetupRows,
    consents: consentRows,
    reportsFiled: reportRows,
  };
}
