import { ACTION_LABELS, type ChatAttachment, type ChatMessageDto, type ChatTurnDto } from '@doggystyle/shared';
import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import { getAiProvider } from '../../ai/index.js';
import { redactPayload } from '../../ai/redact.js';
import type { AgentContext } from '../../ai/types.js';
import { db } from '../../db/client.js';
import {
  agentConfirmations,
  chatMessages,
  chatThreads,
  mediaAssets,
  matchRequests,
  meetupParticipants,
  meetups,
  preferences,
  socialAccounts,
} from '../../db/schema.js';
import { isAppError } from '../../lib/errors.js';
import { notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { Actor } from '../../plugins/auth.js';
import { listConnections } from '../connections/service.js';
import { getPrimaryDog } from '../dogs/service.js';
import { getAction, type ActionContext, type ExecutionResult, type ThreadState } from './registry.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

function toDto(row: typeof chatMessages.$inferSelect): ChatMessageDto {
  return {
    id: row.id,
    role: row.role as ChatMessageDto['role'],
    text: row.text,
    attachments: (row.attachments ?? []) as ChatAttachment[],
    suggestions: row.suggestions ?? [],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function assertThreadOwner(threadId: string, userId: string) {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  if (!thread) throw notFound('We could not find that conversation.');
  return thread;
}

export async function createThread(userId: string, brandName: string): Promise<string> {
  const [thread] = await db.insert(chatThreads).values({ userId, state: {} }).returning({ id: chatThreads.id });
  const threadId = thread!.id;

  await db.insert(chatMessages).values({
    threadId,
    userId,
    role: 'assistant',
    text:
      `Hi! I’m ${brandName}. Tell me what you’d like for your dog and I’ll handle the rest.\n\n` +
      'If you connect a photo source I can build your dog’s profile automatically — then you can correct anything just by telling me.',
    attachments: [],
    suggestions: ['Connect a photo source', 'Upload photos instead', 'Find my dog a playmate nearby'],
  });

  return threadId;
}

export async function listThreads(userId: string) {
  return db
    .select({ id: chatThreads.id, title: chatThreads.title, updatedAt: chatThreads.updatedAt })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(50);
}

export async function listThreadMessages(threadId: string, userId: string): Promise<ChatMessageDto[]> {
  await assertThreadOwner(threadId, userId);
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(300);
  return rows.map(toDto);
}

/* ── Context assembly ─────────────────────────────────────────────────────── */

async function buildContext(actor: Actor, threadId: string, state: ThreadState): Promise<AgentContext> {
  const primary = await getPrimaryDog(actor.userId);

  const [[photos], [sources], [pendingIntros], connections, recent] = await Promise.all([
    db
      .select({ n: count() })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.userId, actor.userId), isNull(mediaAssets.deletedAt))),
    db
      .select({ n: count() })
      .from(socialAccounts)
      .where(and(eq(socialAccounts.userId, actor.userId), isNull(socialAccounts.revokedAt))),
    db
      .select({ n: count() })
      .from(matchRequests)
      .where(and(eq(matchRequests.toUserId, actor.userId), eq(matchRequests.status, 'pending'))),
    listConnections(actor.userId),
    db
      .select({ role: chatMessages.role, text: chatMessages.text })
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(6),
  ]);

  const [upcoming] = await db
    .select({ n: count() })
    .from(meetups)
    .innerJoin(
      meetupParticipants,
      and(eq(meetupParticipants.meetupId, meetups.id), eq(meetupParticipants.userId, actor.userId)),
    )
    .where(eq(meetups.status, 'accepted'));

  const [prefs] = primary
    ? await db
        .select({ radiusKm: preferences.radiusKm })
        .from(preferences)
        .where(and(eq(preferences.userId, actor.userId), eq(preferences.dogId, primary.dog.id)))
        .limit(1)
    : [undefined];

  return {
    dogName: primary?.dog.name ?? null,
    dogBreed: primary?.profile.breed ?? null,
    dogAgeYears: primary?.profile.ageYears ?? null,
    defaultRadiusKm: prefs?.radiusKm ?? 15,
    city: primary?.profile.city ?? null,
    now: new Date().toISOString(),
    hasDog: !!primary,
    hasProfileDraft: !!primary && (primary.profile.completeness ?? 0) < 0.6,
    hasConnectedSource: (sources?.n ?? 0) > 0,
    photoCount: photos?.n ?? 0,
    lastSearchId: state.lastSearchId ?? null,
    lastCandidateNames: (state.lastCandidates ?? []).map((c) => c.name),
    pendingIntroductions: pendingIntros?.n ?? 0,
    openConnections: connections
      .filter((c) => c.status === 'active')
      .map((c) => ({ peerDogName: c.peerDog.name, connectionId: c.connectionId })),
    upcomingMeetups: upcoming?.n ?? 0,
    recentTurns: recent
      .reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })),
  };
}

async function persistAssistant(
  threadId: string,
  userId: string,
  result: ExecutionResult,
  actionName: string | null,
  actionArgs: Record<string, unknown> | null,
): Promise<ChatMessageDto> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      threadId,
      userId,
      role: 'assistant',
      text: result.reply,
      attachments: result.attachments,
      suggestions: result.suggestions,
      actionName,
      // Redacted: chat rows are read by the admin console.
      actionArgs: actionArgs ? redactPayload(actionArgs) : null,
    })
    .returning();
  return toDto(row!);
}

async function mergeState(threadId: string, current: ThreadState, delta?: Partial<ThreadState>): Promise<void> {
  const next = { ...current, ...(delta ?? {}) };
  await db.update(chatThreads).set({ state: next, updatedAt: new Date() }).where(eq(chatThreads.id, threadId));
}

/* ── The turn ─────────────────────────────────────────────────────────────── */

export async function runChatTurn(input: {
  actor: Actor;
  threadId: string;
  text: string;
  requestId: string | null;
}): Promise<ChatTurnDto> {
  const { actor, threadId, text, requestId } = input;
  const thread = await assertThreadOwner(threadId, actor.userId);
  const state = (thread.state ?? {}) as ThreadState;

  const [userRow] = await db
    .insert(chatMessages)
    .values({ threadId, userId: actor.userId, role: 'user', text: text.trim().slice(0, 1000), attachments: [], suggestions: [] })
    .returning();

  if (!thread.title) {
    await db
      .update(chatThreads)
      .set({ title: text.trim().slice(0, 60) })
      .where(eq(chatThreads.id, threadId));
  }

  const context = await buildContext(actor, threadId, state);
  const decision = await getAiProvider().decideAction({ utterance: text, context });

  const entry = getAction(decision.action);
  let assistant: ChatMessageDto;

  if (!entry) {
    // Unknown action name: the model may only ever choose from the registry.
    assistant = await persistAssistant(
      threadId,
      actor.userId,
      { reply: 'I’m not sure how to do that yet. Try asking me to find matches or update the profile.', attachments: [], suggestions: [] },
      null,
      null,
    );
    return { conversationId: threadId, messages: [toDto(userRow!), assistant] };
  }

  const parsedArgs = entry.def.schema.safeParse({
    ...decision.args,
    ...(entry.name === 'find_matches' ? { __utterance: text } : {}),
  });

  if (!parsedArgs.success) {
    assistant = await persistAssistant(
      threadId,
      actor.userId,
      {
        reply: decision.reply || 'I didn’t quite catch that — could you say it a different way?',
        attachments: [],
        suggestions: decision.suggestions,
      },
      null,
      null,
    );
    return { conversationId: threadId, messages: [toDto(userRow!), assistant] };
  }

  const args = parsedArgs.data as Record<string, unknown>;

  // Sensitive actions never execute straight from model output (ADR 0004).
  if (entry.def.category === 'sensitive') {
    const described = entry.def.describe?.(args) ?? { summary: ACTION_LABELS[entry.name], detail: [] };
    const [confirmation] = await db
      .insert(agentConfirmations)
      .values({
        userId: actor.userId,
        threadId,
        action: entry.name,
        args,
        summary: described.summary,
        detail: described.detail,
        status: 'pending',
        expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
      })
      .returning();

    assistant = await persistAssistant(
      threadId,
      actor.userId,
      {
        reply: decision.reply || 'Just to be safe — confirm and I’ll do it.',
        attachments: [
          {
            kind: 'confirmation',
            confirmation: {
              id: confirmation!.id,
              action: entry.name,
              summary: described.summary,
              detail: described.detail,
              args: redactPayload(args),
              expiresAt: confirmation!.expiresAt.toISOString(),
            },
          },
        ],
        suggestions: [],
      },
      entry.name,
      args,
    );
    return { conversationId: threadId, messages: [toDto(userRow!), assistant] };
  }

  const ctx: ActionContext = { actor, threadId, state, requestId, utterance: text };
  let result: ExecutionResult;
  try {
    result = await entry.def.execute(args, ctx);
  } catch (err) {
    // Domain errors become conversation, not HTTP failures.
    if (isAppError(err)) {
      result = { reply: err.message, attachments: [], suggestions: decision.suggestions };
    } else {
      logger.error({ err, action: entry.name }, 'chat action failed');
      result = { reply: 'Something went wrong on my side. Try that again in a moment.', attachments: [], suggestions: [] };
    }
  }

  await mergeState(threadId, state, result.stateDelta);
  assistant = await persistAssistant(threadId, actor.userId, result, entry.name, args);
  return { conversationId: threadId, messages: [toDto(userRow!), assistant] };
}

export async function resolveConfirmation(input: {
  actor: Actor;
  confirmationId: string;
  confirm: boolean;
  requestId: string | null;
}): Promise<ChatTurnDto> {
  const { actor, confirmationId, confirm, requestId } = input;

  const [row] = await db
    .select()
    .from(agentConfirmations)
    .where(and(eq(agentConfirmations.id, confirmationId), eq(agentConfirmations.userId, actor.userId)))
    .limit(1);

  if (!row) throw notFound('That confirmation is no longer available.');
  if (row.status !== 'pending') throw notFound('That confirmation has already been handled.');

  const threadId = row.threadId ?? (await listThreads(actor.userId))[0]?.id;
  if (!threadId) throw notFound('That confirmation is no longer available.');

  if (row.expiresAt.getTime() < Date.now()) {
    await db.update(agentConfirmations).set({ status: 'expired' }).where(eq(agentConfirmations.id, row.id));
    const expired = await persistAssistant(
      threadId,
      actor.userId,
      { reply: 'That request timed out — ask me again and I’ll redo it.', attachments: [], suggestions: [] },
      null,
      null,
    );
    return { conversationId: threadId, messages: [expired] };
  }

  if (!confirm) {
    await db.update(agentConfirmations).set({ status: 'cancelled' }).where(eq(agentConfirmations.id, row.id));
    const cancelled = await persistAssistant(
      threadId,
      actor.userId,
      { reply: 'No problem — I didn’t do it.', attachments: [], suggestions: [] },
      null,
      null,
    );
    return { conversationId: threadId, messages: [cancelled] };
  }

  const entry = getAction(row.action);
  if (!entry) throw notFound('That action is no longer available.');

  const thread = await assertThreadOwner(threadId, actor.userId);
  const state = (thread.state ?? {}) as ThreadState;

  // Re-validate the stored args and re-authorise against the *current* session.
  const parsed = entry.def.schema.safeParse(row.args);
  if (!parsed.success) throw notFound('That action is no longer valid.');

  let result: ExecutionResult;
  try {
    result = await entry.def.execute(parsed.data as Record<string, unknown>, {
      actor,
      threadId,
      state,
      requestId,
      utterance: '',
    });
  } catch (err) {
    result = isAppError(err)
      ? { reply: err.message, attachments: [], suggestions: [] }
      : { reply: 'Something went wrong on my side.', attachments: [], suggestions: [] };
    logger.error({ err, action: row.action }, 'confirmed action failed');
  }

  await db.update(agentConfirmations).set({ status: 'confirmed' }).where(eq(agentConfirmations.id, row.id));
  await mergeState(threadId, state, result.stateDelta);
  const assistant = await persistAssistant(threadId, actor.userId, result, row.action, row.args);
  return { conversationId: threadId, messages: [assistant] };
}
