import { MATCH_INTENT_LABELS, type MatchIntent, type MeetupDto } from '@doggystyle/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { dogProfiles, dogs, meetupParticipants, meetups, notifications, users } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { KNOWN_CITIES, haversineKm, midpoint, type LatLng } from '../../lib/geo.js';
import { assertConnectionParticipant, peerOf } from '../connections/service.js';
import { sendMessage } from '../messaging/service.js';

const MAX_DURATION_MS = 6 * 3600 * 1000;

/**
 * Suggest a *public area* roughly halfway between two owners.
 *
 * Deliberately never an address from anyone's profile: we take the midpoint of
 * the two already-coarsened points and name the nearest known city. The stored
 * lat/lng is the midpoint, never a home coordinate.
 */
function suggestLocation(a: LatLng | null, b: LatLng | null): { label: string; lat: number | null; lng: number | null } {
  if (!a || !b) {
    return { label: 'A public spot halfway between you', lat: null, lng: null };
  }
  const mid = midpoint(a, b);
  let nearest = KNOWN_CITIES[0]!;
  let best = Number.POSITIVE_INFINITY;
  for (const city of KNOWN_CITIES) {
    const d = haversineKm(mid, { lat: city.lat, lng: city.lng });
    if (d < best) {
      best = d;
      nearest = city;
    }
  }
  const label =
    best <= 25 ? `${nearest.city} — a public park or open meeting spot` : 'A public spot halfway between you';
  return { label, lat: mid.lat, lng: mid.lng };
}

async function ownerPoint(userId: string): Promise<LatLng | null> {
  const [row] = await db.select({ lat: users.lat, lng: users.lng }).from(users).where(eq(users.id, userId)).limit(1);
  if (!row || row.lat === null || row.lng === null) return null;
  return { lat: row.lat, lng: row.lng };
}

async function loadMeetupDto(meetupId: string, actorUserId: string): Promise<MeetupDto> {
  const [row] = await db.select().from(meetups).where(eq(meetups.id, meetupId)).limit(1);
  if (!row) throw notFound('We could not find that meetup.');

  const participants = await db
    .select({
      userId: meetupParticipants.userId,
      dogId: meetupParticipants.dogId,
      response: meetupParticipants.response,
      dogName: dogs.name,
      photoId: dogProfiles.profilePhotoId,
    })
    .from(meetupParticipants)
    .innerJoin(dogs, eq(dogs.id, meetupParticipants.dogId))
    .leftJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(eq(meetupParticipants.meetupId, meetupId));

  return {
    id: row.id,
    connectionId: row.connectionId,
    status: row.status as MeetupDto['status'],
    intent: row.intent as MatchIntent,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    locationLabel: row.locationLabel,
    locationNote: row.locationNote,
    proposedByUserId: row.proposedByUserId,
    proposedByMe: row.proposedByUserId === actorUserId,
    acceptedByUserIds: participants.filter((p) => p.response === 'accepted').map((p) => p.userId),
    participants: participants.map((p) => ({
      userId: p.userId,
      dogId: p.dogId,
      dogName: p.dogName ?? 'Their dog',
      photoUrl: p.photoId ? `/api/media/${p.photoId}/file` : null,
    })),
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateWindow(startsAt: Date, endsAt: Date): void {
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw badRequest('That date did not parse.');
  if (startsAt.getTime() <= Date.now()) throw badRequest('Pick a time in the future.');
  if (endsAt.getTime() <= startsAt.getTime()) throw badRequest('The end time must be after the start time.');
  if (endsAt.getTime() - startsAt.getTime() > MAX_DURATION_MS) throw badRequest('Keep meetups under six hours.');
}

export async function proposeMeetup(input: {
  actorUserId: string;
  connectionId: string;
  startsAt: Date;
  endsAt: Date;
  title?: string | null;
  locationNote?: string | null;
  requestId?: string | null;
}): Promise<MeetupDto> {
  const { actorUserId, connectionId, startsAt, endsAt, title = null, locationNote = null, requestId = null } = input;

  validateWindow(startsAt, endsAt);
  const connection = await assertConnectionParticipant(connectionId, actorUserId);
  const peer = peerOf(connection, actorUserId);

  const [peerDog] = await db.select({ name: dogs.name }).from(dogs).where(eq(dogs.id, peer.dogId)).limit(1);
  const intent = connection.intent as MatchIntent;

  const [mine, theirs] = await Promise.all([ownerPoint(actorUserId), ownerPoint(peer.userId)]);
  const location = suggestLocation(mine, theirs);

  const meetupId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(meetups)
      .values({
        connectionId,
        proposedByUserId: actorUserId,
        intent,
        title: (title?.trim() || `${MATCH_INTENT_LABELS[intent]} with ${peerDog?.name ?? 'their dog'}`).slice(0, 120),
        status: 'proposed',
        startsAt,
        endsAt,
        locationLabel: location.label,
        locationNote: locationNote ? locationNote.slice(0, 300) : null,
        lat: location.lat,
        lng: location.lng,
      })
      .returning({ id: meetups.id });

    const id = created!.id;
    await tx.insert(meetupParticipants).values([
      { meetupId: id, userId: actorUserId, dogId: peer.myDogId, response: 'accepted', respondedAt: new Date() },
      { meetupId: id, userId: peer.userId, dogId: peer.dogId, response: 'pending' },
    ]);
    return id;
  });

  await sendMessage({
    actorUserId,
    connectionId,
    kind: 'meetup_proposal',
    body: `Proposed a meetup: ${startsAt.toUTCString()} at ${location.label}`,
    metadata: { meetupId },
  });

  await db.insert(notifications).values({
    userId: peer.userId,
    kind: 'meetup',
    title: 'New meetup proposal',
    body: location.label,
    link: '/app/meetups',
  });

  await recordAudit({
    actorUserId,
    action: 'meetup.propose',
    targetType: 'meetup',
    targetId: meetupId,
    requestId,
  });

  return loadMeetupDto(meetupId, actorUserId);
}

async function assertMeetupParticipant(
  meetupId: string,
  actorUserId: string,
): Promise<{ meetup: typeof meetups.$inferSelect; response: string }> {
  const [row] = await db
    .select({ meetup: meetups, response: meetupParticipants.response })
    .from(meetups)
    .innerJoin(
      meetupParticipants,
      and(eq(meetupParticipants.meetupId, meetups.id), eq(meetupParticipants.userId, actorUserId)),
    )
    .where(eq(meetups.id, meetupId))
    .limit(1);
  if (!row) throw notFound('We could not find that meetup.');
  return row;
}

export async function respondMeetup(input: {
  actorUserId: string;
  meetupId: string;
  accept: boolean;
  requestId?: string | null;
}): Promise<MeetupDto> {
  const { actorUserId, meetupId, accept, requestId = null } = input;
  const { meetup } = await assertMeetupParticipant(meetupId, actorUserId);

  if (meetup.status === 'cancelled' || meetup.status === 'completed') {
    throw conflict('That meetup is already closed.');
  }

  await db
    .update(meetupParticipants)
    .set({ response: accept ? 'accepted' : 'declined', respondedAt: new Date() })
    .where(and(eq(meetupParticipants.meetupId, meetupId), eq(meetupParticipants.userId, actorUserId)));

  const participants = await db
    .select({ response: meetupParticipants.response })
    .from(meetupParticipants)
    .where(eq(meetupParticipants.meetupId, meetupId));

  let nextStatus = meetup.status;
  if (!accept) nextStatus = 'declined';
  else if (participants.every((p) => p.response === 'accepted')) nextStatus = 'accepted';

  if (nextStatus !== meetup.status) {
    await db.update(meetups).set({ status: nextStatus, updatedAt: new Date() }).where(eq(meetups.id, meetupId));
  }

  await sendMessage({
    actorUserId,
    connectionId: meetup.connectionId,
    kind: 'meetup_update',
    body: accept
      ? nextStatus === 'accepted'
        ? 'Meetup confirmed 🎉'
        : 'Accepted the meetup — waiting on the other owner.'
      : 'Declined the meetup.',
    metadata: { meetupId },
  });

  await recordAudit({
    actorUserId,
    action: accept ? 'meetup.accept' : 'meetup.decline',
    targetType: 'meetup',
    targetId: meetupId,
    requestId,
  });

  // Note: meet counts / rapport are updated when a meetup is marked completed —
  // that transition is a follow-up (needs a post-meetup prompt).
  return loadMeetupDto(meetupId, actorUserId);
}

export async function rescheduleMeetup(input: {
  actorUserId: string;
  meetupId: string;
  startsAt: Date;
  endsAt: Date;
  requestId?: string | null;
}): Promise<MeetupDto> {
  const { actorUserId, meetupId, startsAt, endsAt, requestId = null } = input;
  validateWindow(startsAt, endsAt);

  const { meetup } = await assertMeetupParticipant(meetupId, actorUserId);
  if (meetup.status !== 'proposed' && meetup.status !== 'accepted') {
    throw conflict('That meetup can no longer be rescheduled.');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(meetups)
      .set({ startsAt, endsAt, status: 'proposed', updatedAt: new Date() })
      .where(eq(meetups.id, meetupId));
    // A new time needs fresh consent from the other side.
    await tx
      .update(meetupParticipants)
      .set({ response: 'pending', respondedAt: null })
      .where(eq(meetupParticipants.meetupId, meetupId));
    await tx
      .update(meetupParticipants)
      .set({ response: 'accepted', respondedAt: new Date() })
      .where(and(eq(meetupParticipants.meetupId, meetupId), eq(meetupParticipants.userId, actorUserId)));
  });

  await sendMessage({
    actorUserId,
    connectionId: meetup.connectionId,
    kind: 'meetup_update',
    body: `New time suggested: ${startsAt.toUTCString()}`,
    metadata: { meetupId },
  });

  await recordAudit({ actorUserId, action: 'meetup.reschedule', targetType: 'meetup', targetId: meetupId, requestId });
  return loadMeetupDto(meetupId, actorUserId);
}

export async function cancelMeetup(input: {
  actorUserId: string;
  meetupId: string;
  reason?: string | null;
  requestId?: string | null;
}): Promise<MeetupDto> {
  const { actorUserId, meetupId, reason = null, requestId = null } = input;
  const { meetup } = await assertMeetupParticipant(meetupId, actorUserId);

  if (meetup.status === 'cancelled' || meetup.status === 'completed') {
    throw conflict('That meetup is already closed.');
  }

  await db
    .update(meetups)
    .set({
      status: 'cancelled',
      cancelledByUserId: actorUserId,
      cancelReason: reason ? reason.slice(0, 200) : null,
      updatedAt: new Date(),
    })
    .where(eq(meetups.id, meetupId));

  await sendMessage({
    actorUserId,
    connectionId: meetup.connectionId,
    kind: 'meetup_update',
    body: reason ? `Cancelled the meetup: ${reason.slice(0, 200)}` : 'Cancelled the meetup.',
    metadata: { meetupId },
  });

  await recordAudit({ actorUserId, action: 'meetup.cancel', targetType: 'meetup', targetId: meetupId, requestId });
  return loadMeetupDto(meetupId, actorUserId);
}

export async function listMeetups(actorUserId: string): Promise<MeetupDto[]> {
  const mine = await db
    .select({ meetupId: meetupParticipants.meetupId })
    .from(meetupParticipants)
    .where(eq(meetupParticipants.userId, actorUserId));

  const ids = mine.map((m) => m.meetupId);
  if (ids.length === 0) return [];

  const rows = await db
    .select({ id: meetups.id })
    .from(meetups)
    .where(inArray(meetups.id, ids))
    .orderBy(desc(meetups.startsAt))
    .limit(100);

  return Promise.all(rows.map((r) => loadMeetupDto(r.id, actorUserId)));
}

/** Shared by the chat agent: resolve a natural-language time to a concrete window. */
export function resolveWhen(
  label: string | null | undefined,
  now = new Date(),
): { startsAt: Date; endsAt: Date } {
  const text = (label ?? '').toLowerCase();
  const dayparts: Record<string, number> = {
    early_morning: 7,
    'early morning': 7,
    morning: 9,
    midday: 12,
    noon: 12,
    lunchtime: 12,
    afternoon: 15,
    evening: 18,
    night: 20,
    tonight: 20,
  };
  const weekdays: Record<string, number> = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
    thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
  };

  let hour = 10;
  for (const [key, h] of Object.entries(dayparts)) {
    if (text.includes(key)) {
      hour = h;
      break;
    }
  }

  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(0);
  start.setHours(hour);

  let targetDow: number | null = null;
  for (const [key, dow] of Object.entries(weekdays)) {
    if (new RegExp(`\\b${key}\\b`).test(text)) {
      targetDow = dow;
      break;
    }
  }
  if (targetDow === null && (text.includes('weekend') || text === '')) targetDow = 6;

  if (text.includes('tomorrow')) {
    start.setDate(start.getDate() + 1);
  } else if (targetDow !== null) {
    let delta = (targetDow - start.getDay() + 7) % 7;
    if (delta === 0 && start.getTime() <= now.getTime()) delta = 7;
    start.setDate(start.getDate() + delta);
  }

  if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 7);

  return { startsAt: start, endsAt: new Date(start.getTime() + 90 * 60 * 1000) };
}
