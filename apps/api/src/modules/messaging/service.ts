import type { MessageDto } from '@doggystyle/shared';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { conversations, messageDeliveries, messages, notifications } from '../../db/schema.js';
import { recordAudit } from '../../lib/audit.js';
import { notFound } from '../../lib/errors.js';
import { assertConnectionParticipant, peerOf } from '../connections/service.js';

export type MessageKind = 'text' | 'system' | 'meetup_proposal' | 'meetup_update' | 'introduction';

function toDto(row: typeof messages.$inferSelect, actorUserId: string): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    kind: row.kind as MessageDto['kind'],
    body: row.body,
    metadata: row.metadata ?? null,
    mine: row.senderUserId === actorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function conversationIdFor(connectionId: string): Promise<string> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.connectionId, connectionId))
    .limit(1);
  if (!row) throw notFound('We could not find that conversation.');
  return row.id;
}

/**
 * Internal transport today. `message_deliveries` exists so a WhatsApp/SMS
 * adapter can be added later without touching callers (ARCHITECTURE.md §11).
 */
export async function sendMessage(input: {
  actorUserId: string;
  connectionId: string;
  body: string;
  kind?: MessageKind;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
}): Promise<MessageDto> {
  const { actorUserId, connectionId, body, kind = 'text', metadata = null, requestId = null } = input;

  const connection = await assertConnectionParticipant(connectionId, actorUserId);
  const conversationId = await conversationIdFor(connectionId);
  const peer = peerOf(connection, actorUserId);

  const [created] = await db
    .insert(messages)
    .values({
      conversationId,
      // System-authored messages carry no sender.
      senderUserId: kind === 'system' ? null : actorUserId,
      kind,
      body: body.trim().slice(0, 2000),
      metadata,
    })
    .returning();

  const row = created!;
  const now = new Date();

  await db.update(conversations).set({ lastMessageAt: now }).where(eq(conversations.id, conversationId));
  await db.insert(messageDeliveries).values({ messageId: row.id, transport: 'internal', status: 'delivered' });

  if (kind !== 'system') {
    // Only notify when the peer has nothing unread here already — avoids one
    // notification per message in a fast back-and-forth.
    const [alreadyUnread] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderUserId, actorUserId),
          isNull(messages.readAt),
          ne(messages.id, row.id),
        ),
      )
      .limit(1);

    if (!alreadyUnread) {
      await db.insert(notifications).values({
        userId: peer.userId,
        kind: 'message',
        title: 'New message',
        body: null,
        link: `/app/messages/${connectionId}`,
      });
    }
  }

  if (kind === 'text') {
    await recordAudit({
      actorUserId,
      action: 'message.send',
      targetType: 'connection',
      targetId: connectionId,
      requestId,
    });
  }

  return toDto(row, actorUserId);
}

export async function listMessages(input: {
  actorUserId: string;
  connectionId: string;
  limit?: number;
}): Promise<MessageDto[]> {
  const { actorUserId, connectionId, limit = 200 } = input;

  // Reading history stays available after a connection is revoked.
  await assertConnectionParticipant(connectionId, actorUserId, { requireActive: false });
  const conversationId = await conversationIdFor(connectionId);

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt))
    .limit(Math.min(500, Math.max(1, limit)));

  // Mark the peer's messages read as a side effect of opening the thread.
  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNull(messages.readAt),
        ne(messages.senderUserId, actorUserId),
      ),
    );

  return rows.map((r) => toDto(r, actorUserId));
}
