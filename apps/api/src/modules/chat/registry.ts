import {
  ACTION_CATEGORIES,
  ACTION_LABELS,
  MATCH_INTENTS,
  SOCIAL_PROVIDER_IDS,
  REPORT_REASONS,
  type AgentActionName,
  type ChatAttachment,
  type MatchIntent,
} from '@doggystyle/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z, type ZodTypeAny } from 'zod';
import { getAiProvider } from '../../ai/index.js';
import { db } from '../../db/client.js';
import { candidateMatches, dogProfiles, mediaAssets, matchRequests, preferences } from '../../db/schema.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Actor } from '../../plugins/auth.js';
import {
  assertConnectionParticipant,
  listConnections,
  listIntroductions,
  peerOf,
  requestIntroduction,
  respondIntroduction,
} from '../connections/service.js';
import {
  applyAttributeUpdates,
  confirmAttributes,
  createDogWithProfile,
  generateProfileFromMedia,
  getDogProfileDto,
  getPrimaryDog,
} from '../dogs/service.js';
import { deleteMediaAsset } from '../media/service.js';
import { getSearchCandidate, runMatchSearch } from '../matching/engine.js';
import { cancelMeetup, listMeetups, proposeMeetup, rescheduleMeetup, resolveWhen } from '../meetups/service.js';
import { sendMessage } from '../messaging/service.js';
import { blockUser, reportUser } from '../moderation/service.js';
import { connectProvider, disconnectProvider, getProviderDescriptors } from '../social/service.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * Thread state — the ONLY place the agent may resolve references from.
 *
 * A model-supplied uuid is never trusted (ADR 0004): candidates, connections
 * and photos are resolved out of this state or via actor-scoped DB queries.
 * ───────────────────────────────────────────────────────────────────────────*/

export interface ThreadState {
  lastSearchId?: string | null;
  lastShownRank?: number;
  lastCandidates?: Array<{ candidateMatchId: string; dogId: string; name: string; rank: number }>;
  activeDogId?: string | null;
}

export interface ActionContext {
  actor: Actor;
  threadId: string;
  state: ThreadState;
  requestId: string | null;
  /** The raw user utterance for this turn — used by intent parsing. */
  utterance: string;
}

export interface ExecutionResult {
  reply: string;
  attachments: ChatAttachment[];
  suggestions: string[];
  stateDelta?: Partial<ThreadState>;
}

export interface ActionDefinition {
  schema: ZodTypeAny;
  category: (typeof ACTION_CATEGORIES)[AgentActionName];
  /** Human summary shown on the confirmation card for sensitive actions. */
  describe?: (args: Record<string, unknown>) => { summary: string; detail: string[] };
  execute: (args: Record<string, unknown>, ctx: ActionContext) => Promise<ExecutionResult>;
}

const empty = z.object({}).passthrough();

/* ── Small resolution helpers (all actor-scoped) ───────────────────────────── */

async function activeDogId(ctx: ActionContext): Promise<string> {
  if (ctx.state.activeDogId) return ctx.state.activeDogId;
  const primary = await getPrimaryDog(ctx.actor.userId);
  if (!primary) throw badRequest('Let’s create your dog’s profile first.');
  return primary.dog.id;
}

function pickCandidate(ctx: ActionContext, name?: string | null) {
  const list = ctx.state.lastCandidates ?? [];
  if (list.length === 0) return null;
  if (!name) return list[0]!;
  const needle = name.trim().toLowerCase();
  return list.find((c) => c.name.toLowerCase() === needle) ?? list.find((c) => c.name.toLowerCase().includes(needle)) ?? null;
}

async function resolveConnection(ctx: ActionContext, peerDogName?: string | null) {
  const connections = await listConnections(ctx.actor.userId);
  const active = connections.filter((c) => c.status === 'active');
  if (active.length === 0) return null;
  if (!peerDogName) return active[0]!;
  const needle = peerDogName.trim().toLowerCase();
  return active.find((c) => c.peerDog.name.toLowerCase().includes(needle)) ?? active[0]!;
}

async function profileAttachment(dogId: string, actorUserId: string): Promise<ChatAttachment> {
  return { kind: 'dog_profile', profile: await getDogProfileDto(dogId, actorUserId) };
}

async function connectPromptAttachment(userId: string): Promise<ChatAttachment> {
  return { kind: 'connect_prompt', providers: await getProviderDescriptors(userId) };
}

const NEEDS_DOG_SUGGESTIONS = ['Connect a photo source', 'Upload photos instead'];

/* ─────────────────────────────────────────────────────────────────────────────
 * The registry
 * ───────────────────────────────────────────────────────────────────────────*/

export const actionRegistry: Record<AgentActionName, ActionDefinition> = {
  answer_question: {
    schema: z.object({ reply: z.string().max(1200).optional() }).passthrough(),
    category: ACTION_CATEGORIES.answer_question,
    async execute(args) {
      return {
        reply: typeof args.reply === 'string' && args.reply ? args.reply : 'How can I help with your dog?',
        attachments: [],
        suggestions: [],
      };
    },
  },

  create_profile: {
    schema: z.object({ name: z.string().trim().max(40).optional() }).strict(),
    category: ACTION_CATEGORIES.create_profile,
    async execute(args, ctx) {
      const existing = await getPrimaryDog(ctx.actor.userId);
      const dogId = existing ? existing.dog.id : await createDogWithProfile(ctx.actor.userId, { name: args.name as string | undefined });
      return {
        reply: existing
          ? 'You already have a profile started — here it is.'
          : 'Created a profile. Connect a photo source and I’ll fill it in for you.',
        attachments: [await profileAttachment(dogId, ctx.actor.userId)],
        suggestions: NEEDS_DOG_SUGGESTIONS,
        stateDelta: { activeDogId: dogId },
      };
    },
  },

  update_profile: {
    schema: z
      .object({
        updates: z
          .array(z.object({ key: z.string().min(1).max(60), value: z.unknown() }).strict())
          .min(1)
          .max(12),
      })
      .strict(),
    category: ACTION_CATEGORIES.update_profile,
    async execute(args, ctx) {
      const dogId = await activeDogId(ctx);
      const updates = (args.updates as Array<{ key: string; value: unknown }>).map((u) => ({
        key: u.key,
        value: u.value,
        confidence: 1,
        userConfirmed: true,
      }));
      // source 'user': the owner said it, so it outranks every model inference.
      const profile = await applyAttributeUpdates({
        dogId,
        actorUserId: ctx.actor.userId,
        updates,
        source: 'user',
        requestId: ctx.requestId ?? undefined,
      });
      const changed = updates.map((u) => u.key.replace(/_/g, ' ')).join(', ');
      return {
        reply: `Updated ${changed}. Anything else to correct?`,
        attachments: [{ kind: 'dog_profile', profile }],
        suggestions: ['Find my dog a playmate nearby', 'Show me the full profile'],
        stateDelta: { activeDogId: dogId },
      };
    },
  },

  update_preferences: {
    schema: z
      .object({
        radiusKm: z.number().min(0.5).max(500).optional(),
        intents: z.array(z.enum(MATCH_INTENTS)).max(6).optional(),
        minAgeYears: z.number().min(0).max(30).nullable().optional(),
        maxAgeYears: z.number().min(0).max(30).nullable().optional(),
      })
      .strict(),
    category: ACTION_CATEGORIES.update_preferences,
    async execute(args, ctx) {
      const dogId = await activeDogId(ctx);
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (typeof args.radiusKm === 'number') patch.radiusKm = args.radiusKm;
      if (Array.isArray(args.intents) && args.intents.length) patch.intents = args.intents;
      if (args.minAgeYears !== undefined) patch.minAgeYears = args.minAgeYears;
      if (args.maxAgeYears !== undefined) patch.maxAgeYears = args.maxAgeYears;

      await db
        .insert(preferences)
        .values({
          userId: ctx.actor.userId,
          dogId,
          radiusKm: typeof args.radiusKm === 'number' ? args.radiusKm : 15,
          intents: (args.intents as string[] | undefined) ?? ['playdate'],
          minAgeYears: (args.minAgeYears as number | null | undefined) ?? null,
          maxAgeYears: (args.maxAgeYears as number | null | undefined) ?? null,
        })
        .onConflictDoUpdate({ target: [preferences.userId, preferences.dogId], set: patch });

      return {
        reply:
          typeof args.radiusKm === 'number'
            ? `Got it — I’ll only look within ${args.radiusKm} km from now on.`
            : 'Updated your search preferences.',
        attachments: [],
        suggestions: ['Search again with the new settings'],
        stateDelta: { activeDogId: dogId },
      };
    },
  },

  confirm_attribute: {
    schema: z.object({ keys: z.array(z.string().max(60)).min(1).max(30) }).strict(),
    category: ACTION_CATEGORIES.confirm_attribute,
    async execute(args, ctx) {
      const dogId = await activeDogId(ctx);
      const profile = await confirmAttributes({
        dogId,
        actorUserId: ctx.actor.userId,
        keys: args.keys as string[],
        requestId: ctx.requestId ?? undefined,
      });
      return {
        reply: 'Confirmed — thanks. That makes matches more accurate.',
        attachments: [{ kind: 'dog_profile', profile }],
        suggestions: ['Find my dog a playmate nearby'],
      };
    },
  },

  connect_social_account: {
    schema: z.object({ provider: z.enum(SOCIAL_PROVIDER_IDS).optional() }).strict(),
    category: ACTION_CATEGORIES.connect_social_account,
    async execute(args, ctx) {
      if (!args.provider) {
        return {
          reply: 'Pick where your dog’s photos live and I’ll take it from there.',
          attachments: [await connectPromptAttachment(ctx.actor.userId)],
          suggestions: [],
        };
      }
      const result = await connectProvider({
        actorUserId: ctx.actor.userId,
        provider: args.provider as (typeof SOCIAL_PROVIDER_IDS)[number],
        requestId: ctx.requestId ?? undefined,
      });
      if (result.redirectUrl) {
        return {
          reply: 'Opening the authorisation page — approve access and I’ll import from there.',
          attachments: [{ kind: 'notice', tone: 'info', title: 'Authorisation needed', body: result.redirectUrl }],
          suggestions: [],
        };
      }
      if (result.importId) {
        return {
          reply: 'Importing photos now — this takes a few seconds.',
          attachments: [
            {
              kind: 'media_import',
              summary: {
                importId: result.importId,
                provider: args.provider as never,
                itemsFetched: 0,
                itemsStored: 0,
                duplicates: 0,
                dogPhotos: 0,
                clusters: [],
                status: 'queued',
                message: null,
              },
            },
          ],
          suggestions: [],
        };
      }
      return {
        reply: 'Upload your photos and I’ll work out which ones are your dog.',
        attachments: [await connectPromptAttachment(ctx.actor.userId)],
        suggestions: [],
      };
    },
  },

  import_media: {
    schema: empty,
    category: ACTION_CATEGORIES.import_media,
    async execute(_args, ctx) {
      const dog = await getPrimaryDog(ctx.actor.userId);
      const [anyMedia] = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(and(eq(mediaAssets.userId, ctx.actor.userId), isNull(mediaAssets.deletedAt)))
        .limit(1);

      if (anyMedia) {
        const profile = await generateProfileFromMedia({
          userId: ctx.actor.userId,
          dogId: dog?.dog.id,
          requestId: ctx.requestId ?? undefined,
        });
        return {
          reply: `Here’s what I worked out from your photos${profile.name ? ` — meet ${profile.name}` : ''}. Correct anything that’s wrong just by telling me.`,
          attachments: [{ kind: 'dog_profile', profile }],
          suggestions: ['That looks right', 'He’s actually four, not three', 'Find my dog a playmate nearby'],
          stateDelta: { activeDogId: profile.id },
        };
      }

      return {
        reply: 'I don’t have any photos yet — connect a source or upload a few.',
        attachments: [await connectPromptAttachment(ctx.actor.userId)],
        suggestions: [],
      };
    },
  },

  find_matches: {
    schema: z.object({ __utterance: z.string().max(1000).optional() }).passthrough(),
    category: ACTION_CATEGORIES.find_matches,
    async execute(args, ctx) {
      const primary = await getPrimaryDog(ctx.actor.userId);
      if (!primary) {
        return {
          reply: 'First let’s get your dog a profile — connect a photo source and I’ll build it automatically.',
          attachments: [await connectPromptAttachment(ctx.actor.userId)],
          suggestions: NEEDS_DOG_SUGGESTIONS,
        };
      }

      const utterance = (args.__utterance as string | undefined) ?? ctx.utterance;
      const [prefs] = await db
        .select({ radiusKm: preferences.radiusKm })
        .from(preferences)
        .where(and(eq(preferences.userId, ctx.actor.userId), eq(preferences.dogId, primary.dog.id)))
        .limit(1);

      const parsed = await getAiProvider().parseIntent({
        utterance,
        context: {
          dogName: primary.dog.name,
          dogBreed: primary.profile.breed,
          dogAgeYears: primary.profile.ageYears,
          defaultRadiusKm: prefs?.radiusKm ?? 15,
          city: primary.profile.city,
          now: new Date().toISOString(),
        },
      });

      const result = await runMatchSearch({
        actorUserId: ctx.actor.userId,
        dogId: primary.dog.id,
        parsed,
        requestId: ctx.requestId ?? undefined,
      });

      const top = result.candidates[0];
      const reply =
        result.candidates.length === 0
          ? result.notes[0] ?? 'No matches nearby right now. Try widening the search radius.'
          : result.intent === 'mating'
            ? `Found ${result.candidates.length} possible mating match${result.candidates.length === 1 ? '' : 'es'}. These are ranked by how complete each dog’s breeding information is — not by an AI compatibility score.`
            : `Found ${result.candidates.length} good match${result.candidates.length === 1 ? '' : 'es'}${top ? `. ${top.name} looks like the best fit` : ''}.`;

      return {
        reply,
        attachments: [{ kind: 'matches', result }],
        suggestions: result.candidates.length
          ? ['Show me another', 'Only dogs closer than 5 km', `I like ${top?.name ?? 'them'}. Ask their owner.`]
          : ['Search within 25 km', 'Find a walking buddy instead'],
        stateDelta: {
          lastSearchId: result.searchId,
          lastShownRank: result.candidates.length,
          lastCandidates: result.candidates.map((c, i) => ({
            candidateMatchId: c.id,
            dogId: c.dogId,
            name: c.name,
            rank: i + 1,
          })),
          activeDogId: primary.dog.id,
        },
      };
    },
  },

  show_candidate: {
    schema: z.object({ next: z.boolean().optional(), rank: z.number().int().min(1).max(50).optional() }).strict(),
    category: ACTION_CATEGORIES.show_candidate,
    async execute(args, ctx) {
      if (!ctx.state.lastSearchId) {
        return { reply: 'Let’s run a search first — what are you looking for?', attachments: [], suggestions: ['Find my dog a playmate nearby'] };
      }
      const rank = (args.rank as number | undefined) ?? (ctx.state.lastShownRank ?? 0) + 1;
      const candidate = await getSearchCandidate({
        actorUserId: ctx.actor.userId,
        searchId: ctx.state.lastSearchId,
        rank,
      });
      if (!candidate) {
        return {
          reply: 'That’s everyone nearby for now. Want me to widen the search?',
          attachments: [],
          suggestions: ['Search within 25 km', 'Find a walking buddy instead'],
        };
      }
      return {
        reply: `${candidate.name} — ${candidate.distanceLabel}.`,
        attachments: [{ kind: 'candidate', candidate }],
        suggestions: [`I like ${candidate.name}. Ask their owner.`, 'Show me another'],
        stateDelta: { lastShownRank: rank },
      };
    },
  },

  request_introduction: {
    schema: z.object({ candidateName: z.string().max(60).nullable().optional(), message: z.string().max(300).optional() }).strict(),
    category: ACTION_CATEGORIES.request_introduction,
    describe(args) {
      const name = (args.candidateName as string | null | undefined) ?? 'the most recent match';
      return {
        summary: `Ask ${name}'s owner for an introduction`,
        detail: [
          'Their owner will see your dog’s public profile and why you match.',
          'They can accept, decline, or ask a question.',
          'Messaging only opens if they accept.',
        ],
      };
    },
    async execute(args, ctx) {
      const candidate = pickCandidate(ctx, args.candidateName as string | null | undefined);
      if (!candidate) {
        return { reply: 'I’m not sure which dog you mean — run a search and I’ll line one up.', attachments: [], suggestions: ['Find my dog a playmate nearby'] };
      }
      const dogId = await activeDogId(ctx);
      const [row] = await db
        .select({ intent: candidateMatches.searchId, reasons: candidateMatches.reasons })
        .from(candidateMatches)
        .where(eq(candidateMatches.id, candidate.candidateMatchId))
        .limit(1);

      const request = await requestIntroduction({
        actorUserId: ctx.actor.userId,
        fromDogId: dogId,
        toDogId: candidate.dogId,
        intent: 'playdate' as MatchIntent,
        candidateMatchId: candidate.candidateMatchId,
        message: (args.message as string | undefined) ?? null,
        reasons: row?.reasons ?? [],
        requestId: ctx.requestId ?? undefined,
      });

      return {
        reply: `Asked ${candidate.name}'s owner. I’ll let you know as soon as they reply.`,
        attachments: [{ kind: 'introduction', request }],
        suggestions: ['Show me another match', 'What happens next?'],
      };
    },
  },

  accept_introduction: {
    schema: z.object({ peerDogName: z.string().max(60).optional() }).strict(),
    category: ACTION_CATEGORIES.accept_introduction,
    async execute(args, ctx) {
      return respondToIntro(ctx, args.peerDogName as string | undefined, true);
    },
  },

  decline_introduction: {
    schema: z.object({ peerDogName: z.string().max(60).optional() }).strict(),
    category: ACTION_CATEGORIES.decline_introduction,
    async execute(args, ctx) {
      return respondToIntro(ctx, args.peerDogName as string | undefined, false);
    },
  },

  propose_meetup: {
    schema: z.object({ when: z.string().max(80).nullable().optional(), connectionPeer: z.string().max(60).nullable().optional() }).strict(),
    category: ACTION_CATEGORIES.propose_meetup,
    async execute(args, ctx) {
      const connection = await resolveConnection(ctx, args.connectionPeer as string | null | undefined);
      if (!connection) {
        return { reply: 'You don’t have any connections yet — request an introduction first.', attachments: [], suggestions: ['Find my dog a playmate nearby'] };
      }
      const { startsAt, endsAt } = resolveWhen(args.when as string | null | undefined);
      const meetup = await proposeMeetup({
        actorUserId: ctx.actor.userId,
        connectionId: connection.connectionId,
        startsAt,
        endsAt,
        requestId: ctx.requestId ?? undefined,
      });
      return {
        reply: `Proposed a meetup with ${connection.peerDog.name}. They need to accept before it’s confirmed.`,
        attachments: [{ kind: 'meetup', meetup }],
        suggestions: ['Suggest a different time', 'Send them a message'],
      };
    },
  },

  change_meetup: {
    schema: z.object({ when: z.string().max(80).nullable().optional(), connectionPeer: z.string().max(60).nullable().optional() }).strict(),
    category: ACTION_CATEGORIES.change_meetup,
    async execute(args, ctx) {
      const meetups = await listMeetups(ctx.actor.userId);
      const target = meetups.find((m) => m.status === 'proposed' || m.status === 'accepted');
      if (!target) return { reply: 'There’s no upcoming meetup to change.', attachments: [], suggestions: ['Propose a meetup'] };
      const { startsAt, endsAt } = resolveWhen(args.when as string | null | undefined);
      const meetup = await rescheduleMeetup({
        actorUserId: ctx.actor.userId,
        meetupId: target.id,
        startsAt,
        endsAt,
        requestId: ctx.requestId ?? undefined,
      });
      return { reply: 'Suggested a new time — waiting on the other owner.', attachments: [{ kind: 'meetup', meetup }], suggestions: [] };
    },
  },

  cancel_meetup: {
    schema: z.object({ reason: z.string().max(200).optional() }).strict(),
    category: ACTION_CATEGORIES.cancel_meetup,
    describe: () => ({ summary: 'Cancel your upcoming meetup', detail: ['The other owner will be told it is cancelled.'] }),
    async execute(args, ctx) {
      const meetups = await listMeetups(ctx.actor.userId);
      const target = meetups.find((m) => m.status === 'proposed' || m.status === 'accepted');
      if (!target) return { reply: 'There’s no upcoming meetup to cancel.', attachments: [], suggestions: [] };
      const meetup = await cancelMeetup({
        actorUserId: ctx.actor.userId,
        meetupId: target.id,
        reason: (args.reason as string | undefined) ?? null,
        requestId: ctx.requestId ?? undefined,
      });
      return { reply: 'Cancelled, and I let them know.', attachments: [{ kind: 'meetup', meetup }], suggestions: [] };
    },
  },

  send_message: {
    schema: z.object({ peerDogName: z.string().max(60).nullable().optional(), body: z.string().trim().min(1).max(2000) }).strict(),
    category: ACTION_CATEGORIES.send_message,
    async execute(args, ctx) {
      const connection = await resolveConnection(ctx, args.peerDogName as string | null | undefined);
      if (!connection) return { reply: 'You don’t have anyone to message yet.', attachments: [], suggestions: ['Find my dog a playmate nearby'] };
      await sendMessage({
        actorUserId: ctx.actor.userId,
        connectionId: connection.connectionId,
        body: args.body as string,
        requestId: ctx.requestId ?? undefined,
      });
      return {
        reply: `Sent to ${connection.peerDog.name}'s owner.`,
        attachments: [{ kind: 'conversation_link', connectionId: connection.connectionId, peerDogName: connection.peerDog.name }],
        suggestions: ['Propose a meetup', 'Open the conversation'],
      };
    },
  },

  block_user: {
    schema: z.object({ peerDogName: z.string().max(60).nullable().optional() }).strict(),
    category: ACTION_CATEGORIES.block_user,
    describe: (args) => ({
      summary: `Block ${(args.peerDogName as string | undefined) ?? 'this owner'}`,
      detail: ['Your connection is closed and they can no longer message you.', 'They will not appear in your matches.'],
    }),
    async execute(args, ctx) {
      const connection = await resolveConnection(ctx, args.peerDogName as string | null | undefined);
      if (!connection) return { reply: 'I couldn’t work out who you mean.', attachments: [], suggestions: [] };
      await blockUser({ actorUserId: ctx.actor.userId, blockedUserId: connection.peerOwnerId, requestId: ctx.requestId ?? undefined });
      return { reply: 'Blocked. They can’t contact you or see you in matches.', attachments: [], suggestions: [] };
    },
  },

  report_user: {
    schema: z
      .object({ peerDogName: z.string().max(60).nullable().optional(), reason: z.enum(REPORT_REASONS).optional(), detail: z.string().max(2000).optional() })
      .strict(),
    category: ACTION_CATEGORIES.report_user,
    describe: (args) => ({
      summary: `Report ${(args.peerDogName as string | undefined) ?? 'this owner'}`,
      detail: ['A moderator will review this.', 'Your report is not shown to them.'],
    }),
    async execute(args, ctx) {
      const connection = await resolveConnection(ctx, args.peerDogName as string | null | undefined);
      if (!connection) return { reply: 'I couldn’t work out who you mean.', attachments: [], suggestions: [] };
      await reportUser({
        actorUserId: ctx.actor.userId,
        reportedUserId: connection.peerOwnerId,
        reason: (args.reason as never) ?? 'other',
        detail: (args.detail as string | undefined) ?? null,
        requestId: ctx.requestId ?? undefined,
      });
      return { reply: 'Reported — a moderator will look into it. You can block them too if you’d like.', attachments: [], suggestions: ['Block them as well'] };
    },
  },

  delete_media: {
    schema: z.object({ ordinal: z.number().int().min(1).max(50).optional() }).strict(),
    category: ACTION_CATEGORIES.delete_media,
    describe: (args) => ({
      summary: `Delete photo ${(args.ordinal as number | undefined) ?? 1} from the profile`,
      detail: ['The photo is removed from your profile and deleted from storage.'],
    }),
    async execute(args, ctx) {
      const dogId = await activeDogId(ctx);
      const profile = await getDogProfileDto(dogId, ctx.actor.userId);
      const ordinal = (args.ordinal as number | undefined) ?? 1;
      const photo = profile.photos[ordinal - 1];
      if (!photo) return { reply: `You only have ${profile.photos.length} photo(s).`, attachments: [], suggestions: [] };

      await deleteMediaAsset({ actorUserId: ctx.actor.userId, mediaId: photo.id, requestId: ctx.requestId ?? undefined });
      return {
        reply: 'Removed that photo.',
        attachments: [await profileAttachment(dogId, ctx.actor.userId)],
        suggestions: ['Upload a replacement', 'Find my dog a playmate nearby'],
      };
    },
  },

  disconnect_account: {
    schema: z.object({ provider: z.enum(SOCIAL_PROVIDER_IDS) }).strict(),
    category: ACTION_CATEGORIES.disconnect_account,
    describe: (args) => ({
      summary: `Disconnect ${args.provider}`,
      detail: ['No further photos will be imported.', 'Photos already imported stay until you delete them.'],
    }),
    async execute(args, ctx) {
      await disconnectProvider({
        actorUserId: ctx.actor.userId,
        provider: args.provider as (typeof SOCIAL_PROVIDER_IDS)[number],
        requestId: ctx.requestId ?? undefined,
      });
      return { reply: 'Disconnected. Photos already imported are still yours to keep or delete.', attachments: [], suggestions: [] };
    },
  },
};

/* ── shared by accept/decline ─────────────────────────────────────────────── */

async function respondToIntro(ctx: ActionContext, peerDogName: string | undefined, accept: boolean): Promise<ExecutionResult> {
  const incoming = (await listIntroductions(ctx.actor.userId, 'incoming')).filter((r) => r.status === 'pending');
  if (incoming.length === 0) {
    return { reply: 'You have no introduction requests waiting.', attachments: [], suggestions: ['Find my dog a playmate nearby'] };
  }
  const needle = peerDogName?.trim().toLowerCase();
  const target = needle ? incoming.find((r) => r.fromDog.name.toLowerCase().includes(needle)) : incoming[0];
  if (!target) {
    return {
      reply: `You have ${incoming.length} requests waiting — which one? ${incoming.map((r) => r.fromDog.name).join(', ')}`,
      attachments: [],
      suggestions: incoming.slice(0, 3).map((r) => `Accept ${r.fromDog.name}`),
    };
  }

  const request = await respondIntroduction({
    actorUserId: ctx.actor.userId,
    requestId: target.id,
    accept,
    httpRequestId: ctx.requestId,
  });

  const attachments: ChatAttachment[] = [{ kind: 'introduction', request }];
  if (accept && request.connectionId) {
    attachments.push({ kind: 'conversation_link', connectionId: request.connectionId, peerDogName: target.fromDog.name });
  }

  return {
    reply: accept
      ? `You’re connected with ${target.fromDog.name}'s owner — say hello whenever you’re ready.`
      : 'Declined. They’ll just be told it wasn’t a match this time.',
    attachments,
    suggestions: accept ? ['Send them a message', 'Propose a meetup this weekend'] : [],
  };
}

export function actionLabel(name: AgentActionName): string {
  return ACTION_LABELS[name];
}

export function getAction(name: string): { name: AgentActionName; def: ActionDefinition } | null {
  if (!(name in actionRegistry)) return null;
  const key = name as AgentActionName;
  return { name: key, def: actionRegistry[key] };
}
