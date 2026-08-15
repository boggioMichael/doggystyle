import type { MatchIntent, MatchRequestDto, ConnectionSummaryDto } from '@doggystyle/shared';
import { and, desc, eq, inArray, isNull, ne, or, sql as dsql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  blocks,
  candidateMatches,
  connections,
  conversations,
  dogConnections,
  dogProfiles,
  dogs,
  matchRequests,
  meetups,
  messages,
  notifications,
  users,
} from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { redactText } from '../../ai/redact.js';

const INTRO_TTL_DAYS = 14;

type ConnectionRow = typeof connections.$inferSelect;

/* ─────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────────*/

/** A connection row is stored once per pair, with userA/dogA being the lexicographically smaller uuid. */
function canonicalPair(
  userX: string,
  dogX: string,
  userY: string,
  dogY: string,
): { userAId: string; dogAId: string; userBId: string; dogBId: string } {
  return userX < userY
    ? { userAId: userX, dogAId: dogX, userBId: userY, dogBId: dogY }
    : { userAId: userY, dogAId: dogY, userBId: userX, dogBId: dogX };
}

function canonicalDogs(dogX: string, dogY: string): { a: string; b: string } {
  return dogX < dogY ? { a: dogX, b: dogY } : { a: dogY, b: dogX };
}

async function blockExistsBetween(userX: string, userY: string): Promise<boolean> {
  const rows = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerUserId, userX), eq(blocks.blockedUserId, userY)),
        and(eq(blocks.blockerUserId, userY), eq(blocks.blockedUserId, userX)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

interface DogCard {
  id: string;
  name: string;
  photoUrl: string | null;
  breed: string | null;
}

async function loadDogCards(dogIds: string[]): Promise<Map<string, DogCard>> {
  const unique = [...new Set(dogIds)].filter(Boolean);
  if (unique.length === 0) return new Map();

  const rows = await db
    .select({
      id: dogs.id,
      name: dogs.name,
      breed: dogProfiles.breed,
      profilePhotoId: dogProfiles.profilePhotoId,
    })
    .from(dogs)
    .leftJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(inArray(dogs.id, unique));

  return new Map(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        name: r.name ?? 'Their dog',
        breed: r.breed ?? null,
        // Media authorisation is enforced by the media route itself.
        photoUrl: r.profilePhotoId ? `/api/media/${r.profilePhotoId}/file` : null,
      },
    ]),
  );
}

function toMatchRequestDto(
  row: typeof matchRequests.$inferSelect,
  actorUserId: string,
  cards: Map<string, DogCard>,
  connectionId: string | null,
): MatchRequestDto {
  const fallback = (id: string): DogCard => ({ id, name: 'Their dog', photoUrl: null, breed: null });
  return {
    id: row.id,
    status: row.status as MatchRequestDto['status'],
    direction: row.fromUserId === actorUserId ? 'outgoing' : 'incoming',
    intent: row.intent as MatchIntent,
    message: row.message,
    fromDog: cards.get(row.fromDogId) ?? fallback(row.fromDogId),
    toDog: cards.get(row.toDogId) ?? fallback(row.toDogId),
    reasons: row.reasons ?? [],
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    connectionId,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Introductions — mutual consent is the whole point (PRODUCT_SPEC §9)
 * ───────────────────────────────────────────────────────────────────────────*/

export async function requestIntroduction(input: {
  actorUserId: string;
  fromDogId: string;
  toDogId: string;
  intent: MatchIntent;
  candidateMatchId?: string | null;
  message?: string | null;
  reasons?: string[];
  requestId?: string | null;
}): Promise<MatchRequestDto> {
  const {
    actorUserId,
    fromDogId,
    toDogId,
    intent,
    candidateMatchId = null,
    message = null,
    reasons = [],
    requestId = null,
  } = input;

  if (fromDogId === toDogId) throw conflict('That is the same dog.');

  const [fromDog] = await db
    .select({ id: dogs.id, ownerId: dogs.ownerId, name: dogs.name })
    .from(dogs)
    .where(and(eq(dogs.id, fromDogId), eq(dogs.ownerId, actorUserId), isNull(dogs.deletedAt)))
    .limit(1);
  if (!fromDog) throw notFound('We could not find that dog.');

  const [toDog] = await db
    .select({
      id: dogs.id,
      ownerId: dogs.ownerId,
      name: dogs.name,
      visibility: dogProfiles.visibility,
      ownerStatus: users.status,
    })
    .from(dogs)
    .innerJoin(users, eq(users.id, dogs.ownerId))
    .leftJoin(dogProfiles, eq(dogProfiles.dogId, dogs.id))
    .where(and(eq(dogs.id, toDogId), isNull(dogs.deletedAt), eq(dogs.status, 'active')))
    .limit(1);

  // 404 rather than 403 throughout: never confirm that a hidden dog exists.
  if (!toDog || toDog.ownerStatus !== 'active' || toDog.visibility !== 'public') {
    throw notFound('That dog is no longer available.');
  }
  if (toDog.ownerId === actorUserId) throw conflict('That is your own dog.');
  if (await blockExistsBetween(actorUserId, toDog.ownerId)) throw notFound('That dog is no longer available.');

  const pair = canonicalDogs(fromDogId, toDogId);
  const [existingConnection] = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(and(eq(connections.dogAId, pair.a), eq(connections.dogBId, pair.b)))
    .limit(1);
  if (existingConnection && existingConnection.status === 'active') {
    throw conflict('You are already connected with their owner.');
  }

  const [pending] = await db
    .select({ id: matchRequests.id })
    .from(matchRequests)
    .where(
      and(
        eq(matchRequests.status, 'pending'),
        or(
          and(eq(matchRequests.fromDogId, fromDogId), eq(matchRequests.toDogId, toDogId)),
          and(eq(matchRequests.fromDogId, toDogId), eq(matchRequests.toDogId, fromDogId)),
        ),
      ),
    )
    .limit(1);
  if (pending) throw conflict('You have already asked their owner — waiting on a reply.');

  const [created] = await db
    .insert(matchRequests)
    .values({
      fromUserId: actorUserId,
      toUserId: toDog.ownerId,
      fromDogId,
      toDogId,
      candidateMatchId,
      intent,
      message: message ? redactText(message).slice(0, 300) : null,
      reasons: reasons.slice(0, 5),
      status: 'pending',
      expiresAt: new Date(Date.now() + INTRO_TTL_DAYS * 24 * 3600 * 1000),
    })
    .returning();

  const row = created!;

  await db.insert(notifications).values({
    userId: toDog.ownerId,
    kind: 'introduction',
    title: `${fromDog.name ?? 'A dog'} would like to meet ${toDog.name ?? 'your dog'}`,
    body: [row.message, ...(row.reasons ?? [])].filter(Boolean).join(' · ').slice(0, 300) || null,
    link: '/app/intros',
  });

  if (candidateMatchId) {
    await db
      .update(candidateMatches)
      .set({ outcome: 'introduced' })
      .where(eq(candidateMatches.id, candidateMatchId));
  }

  await recordAudit({
    actorUserId,
    action: 'introduction.request',
    targetType: 'match_request',
    targetId: row.id,
    summary: `${fromDog.name ?? 'dog'} → ${toDog.name ?? 'dog'} (${intent})`,
    requestId,
  });

  const cards = await loadDogCards([fromDogId, toDogId]);
  return toMatchRequestDto(row, actorUserId, cards, null);
}

export async function respondIntroduction(input: {
  actorUserId: string;
  requestId: string;
  accept: boolean;
  httpRequestId?: string | null;
}): Promise<MatchRequestDto> {
  const { actorUserId, requestId, accept, httpRequestId = null } = input;

  const [row] = await db.select().from(matchRequests).where(eq(matchRequests.id, requestId)).limit(1);
  if (!row) throw notFound('That introduction request no longer exists.');

  const isTarget = row.toUserId === actorUserId;
  const isRequester = row.fromUserId === actorUserId;
  if (!isTarget && !isRequester) throw notFound('That introduction request no longer exists.');
  if (row.status !== 'pending') throw conflict('That request has already been answered.');
  // The requester may only withdraw; accepting on your own behalf would defeat mutual consent.
  if (isRequester && accept) throw conflict('Only the other owner can accept this.');

  const now = new Date();
  let connectionId: string | null = null;

  if (isRequester && !accept) {
    await db
      .update(matchRequests)
      .set({ status: 'withdrawn', respondedAt: now })
      .where(eq(matchRequests.id, requestId));
  } else if (!accept) {
    await db
      .update(matchRequests)
      .set({ status: 'declined', respondedAt: now })
      .where(eq(matchRequests.id, requestId));
    await db.insert(notifications).values({
      userId: row.fromUserId,
      kind: 'introduction',
      // Deliberately vague: declining should never invite an argument.
      title: 'Your introduction request was not accepted this time',
      body: null,
      link: '/app/intros',
    });
  } else {
    if (await blockExistsBetween(row.fromUserId, row.toUserId)) {
      throw notFound('That introduction request no longer exists.');
    }

    connectionId = await db.transaction(async (tx) => {
      await tx
        .update(matchRequests)
        .set({ status: 'accepted', respondedAt: now })
        .where(eq(matchRequests.id, requestId));

      const pair = canonicalPair(row.fromUserId, row.fromDogId, row.toUserId, row.toDogId);
      const [connection] = await tx
        .insert(connections)
        .values({
          ...pair,
          matchRequestId: row.id,
          intent: row.intent,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [connections.dogAId, connections.dogBId],
          set: { status: 'active', updatedAt: now, matchRequestId: row.id },
        })
        .returning({ id: connections.id });

      const cid = connection!.id;

      const [conversation] = await tx
        .insert(conversations)
        .values({ connectionId: cid, lastMessageAt: now })
        .onConflictDoUpdate({ target: conversations.connectionId, set: { lastMessageAt: now } })
        .returning({ id: conversations.id });

      const why = (row.reasons ?? []).slice(0, 3);
      await tx.insert(messages).values({
        conversationId: conversation!.id,
        senderUserId: null,
        kind: 'system',
        body:
          'You are connected! ' +
          (why.length ? `Doggystyle suggested this because: ${why.join('; ')}.` : 'Say hello and arrange a meetup.'),
        metadata: { matchRequestId: row.id },
      });

      const dogPair = canonicalDogs(row.fromDogId, row.toDogId);
      await tx
        .insert(dogConnections)
        .values({ dogAId: dogPair.a, dogBId: dogPair.b, meetCount: 0 })
        .onConflictDoNothing();

      if (row.candidateMatchId) {
        await tx
          .update(candidateMatches)
          .set({ outcome: 'connected' })
          .where(eq(candidateMatches.id, row.candidateMatchId));
      }

      return cid;
    });

    const cards = await loadDogCards([row.fromDogId, row.toDogId]);
    for (const [userId, otherDogId] of [
      [row.fromUserId, row.toDogId],
      [row.toUserId, row.fromDogId],
    ] as const) {
      await db.insert(notifications).values({
        userId,
        kind: 'connection',
        title: `You are connected with ${cards.get(otherDogId)?.name ?? 'a new friend'}'s owner`,
        body: 'You can message each other and arrange a meetup.',
        link: `/app/messages/${connectionId}`,
      });
    }
  }

  await recordAudit({
    actorUserId,
    action: accept ? 'introduction.accept' : isRequester ? 'introduction.withdraw' : 'introduction.decline',
    targetType: 'match_request',
    targetId: requestId,
    requestId: httpRequestId,
  });

  const [updated] = await db.select().from(matchRequests).where(eq(matchRequests.id, requestId)).limit(1);
  const cards = await loadDogCards([row.fromDogId, row.toDogId]);
  return toMatchRequestDto(updated!, actorUserId, cards, connectionId);
}

export async function listIntroductions(
  actorUserId: string,
  box: 'incoming' | 'outgoing',
): Promise<MatchRequestDto[]> {
  const rows = await db
    .select()
    .from(matchRequests)
    .where(box === 'incoming' ? eq(matchRequests.toUserId, actorUserId) : eq(matchRequests.fromUserId, actorUserId))
    .orderBy(desc(matchRequests.createdAt))
    .limit(100);

  if (rows.length === 0) return [];

  const cards = await loadDogCards(rows.flatMap((r) => [r.fromDogId, r.toDogId]));

  // Attach the resulting connection id for accepted requests so the UI can deep-link.
  const accepted = rows.filter((r) => r.status === 'accepted');
  const connectionByRequest = new Map<string, string>();
  if (accepted.length) {
    const connRows = await db
      .select({ id: connections.id, matchRequestId: connections.matchRequestId })
      .from(connections)
      .where(
        inArray(
          connections.matchRequestId,
          accepted.map((r) => r.id),
        ),
      );
    for (const c of connRows) if (c.matchRequestId) connectionByRequest.set(c.matchRequestId, c.id);
  }

  return rows.map((r) => toMatchRequestDto(r, actorUserId, cards, connectionByRequest.get(r.id) ?? null));
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Connections
 * ───────────────────────────────────────────────────────────────────────────*/

export async function listConnections(actorUserId: string): Promise<ConnectionSummaryDto[]> {
  const rows = await db
    .select({
      connection: connections,
      conversationId: conversations.id,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(connections)
    .innerJoin(conversations, eq(conversations.connectionId, connections.id))
    .where(or(eq(connections.userAId, actorUserId), eq(connections.userBId, actorUserId)))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(100);

  if (rows.length === 0) return [];

  const peerDogIds = rows.map((r) =>
    r.connection.userAId === actorUserId ? r.connection.dogBId : r.connection.dogAId,
  );
  const peerUserIds = rows.map((r) =>
    r.connection.userAId === actorUserId ? r.connection.userBId : r.connection.userAId,
  );
  const cards = await loadDogCards(peerDogIds);

  const owners = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(peerUserIds)]));
  const ownerName = new Map(owners.map((o) => [o.id, o.displayName]));

  const conversationIds = rows.map((r) => r.conversationId);

  // Last message preview + unread count, both scoped to conversations the actor is in.
  const lastMessages = await db
    .select({
      conversationId: messages.conversationId,
      body: messages.body,
      createdAt: messages.createdAt,
      rn: dsql<number>`row_number() over (partition by ${messages.conversationId} order by ${messages.createdAt} desc)`.as(
        'rn',
      ),
    })
    .from(messages)
    .where(inArray(messages.conversationId, conversationIds))
    .as('lm');

  const previews = await db
    .select({ conversationId: lastMessages.conversationId, body: lastMessages.body })
    .from(lastMessages)
    .where(eq(lastMessages.rn, 1));
  const previewByConversation = new Map(previews.map((p) => [p.conversationId, p.body]));

  const unreadRows = await db
    .select({ conversationId: messages.conversationId, n: dsql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        inArray(messages.conversationId, conversationIds),
        isNull(messages.readAt),
        ne(messages.senderUserId, actorUserId),
      ),
    )
    .groupBy(messages.conversationId);
  const unreadByConversation = new Map(unreadRows.map((u) => [u.conversationId, Number(u.n)]));

  const meetupCounts = await db
    .select({ connectionId: meetups.connectionId, n: dsql<number>`count(*)::int` })
    .from(meetups)
    .where(
      inArray(
        meetups.connectionId,
        rows.map((r) => r.connection.id),
      ),
    )
    .groupBy(meetups.connectionId);
  const meetupByConnection = new Map(meetupCounts.map((m) => [m.connectionId, Number(m.n)]));

  return rows.map((r) => {
    const isA = r.connection.userAId === actorUserId;
    const peerDogId = isA ? r.connection.dogBId : r.connection.dogAId;
    const peerUserId = isA ? r.connection.userBId : r.connection.userAId;
    const card = cards.get(peerDogId);
    const preview = previewByConversation.get(r.conversationId) ?? null;

    return {
      connectionId: r.connection.id,
      conversationId: r.conversationId,
      peerDog: card ?? { id: peerDogId, name: 'Their dog', photoUrl: null, breed: null },
      // Never the peer's email — display name or a neutral label.
      peerOwnerDisplayName: ownerName.get(peerUserId) ?? 'Their owner',
      peerOwnerId: peerUserId,
      intent: r.connection.intent as MatchIntent,
      lastMessagePreview: preview ? redactText(preview).slice(0, 80) : null,
      lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      unreadCount: unreadByConversation.get(r.conversationId) ?? 0,
      meetupCount: meetupByConnection.get(r.connection.id) ?? 0,
      status: r.connection.status === 'revoked' ? 'revoked' : 'active',
    };
  });
}

/**
 * Authorisation gate for everything that hangs off a connection.
 * `requireActive` is false for reads: a revoked connection keeps its history
 * visible to both participants, but no new writes are allowed.
 */
export async function assertConnectionParticipant(
  connectionId: string,
  userId: string,
  opts: { requireActive?: boolean } = {},
): Promise<ConnectionRow> {
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        or(eq(connections.userAId, userId), eq(connections.userBId, userId)),
      ),
    )
    .limit(1);

  if (!row) throw notFound('We could not find that conversation.');
  if (opts.requireActive !== false && row.status !== 'active') {
    throw conflict('This connection is no longer active.');
  }
  return row;
}

export function peerOf(connection: ConnectionRow, userId: string): { userId: string; dogId: string; myDogId: string } {
  return connection.userAId === userId
    ? { userId: connection.userBId, dogId: connection.dogBId, myDogId: connection.dogAId }
    : { userId: connection.userAId, dogId: connection.dogAId, myDogId: connection.dogBId };
}

/** Used by blocking: kills the connection and closes the door on new messages. */
export async function revokeConnectionsBetween(userX: string, userY: string, byUserId: string): Promise<void> {
  await db
    .update(connections)
    .set({ status: 'revoked', revokedByUserId: byUserId, updatedAt: new Date() })
    .where(
      or(
        and(eq(connections.userAId, userX), eq(connections.userBId, userY)),
        and(eq(connections.userAId, userY), eq(connections.userBId, userX)),
      ),
    );
}
