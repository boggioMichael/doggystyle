import { describe, expect, it } from 'vitest';
import { decideActionHeuristic } from '../src/ai/heuristic/controller.js';
import type { AgentContext } from '../src/ai/types.js';
import { getAction, type ActionContext } from '../src/modules/chat/registry.js';

const baseContext: AgentContext = {
  dogName: 'Molly',
  dogBreed: 'Beagle',
  dogAgeYears: 4,
  defaultRadiusKm: 15,
  city: 'Tel Aviv',
  now: '2026-08-16T08:00:00.000Z',
  hasDog: true,
  hasProfileDraft: true,
  hasConnectedSource: true,
  photoCount: 7,
  lastSearchId: null,
  lastCandidateNames: [],
  pendingIntroductions: 0,
  openConnections: [],
  upcomingMeetups: 0,
  recentTurns: [
    { role: 'assistant', text: 'Here’s what I worked out from your photos. Correct anything that’s wrong just by telling me.' },
  ],
};

describe('chat dialogue policy', () => {
  it('treats “That looks right” as confirming the current profile draft', () => {
    const decision = decideActionHeuristic('That looks right', baseContext);
    expect(decision.action).toBe('confirm_attribute');
    expect(Array.isArray(decision.args.keys)).toBe(true);
    expect(decision.args.keys).toContain('breed');
    expect(decision.args.keys).toContain('age_years');
  });

  it('treats “continue with my dog one” as continuing the workflow', () => {
    const decision = decideActionHeuristic('continue with my dog one', baseContext);
    expect(decision.action).toBe('find_matches');
    expect(decision.reply.toLowerCase()).toContain('search');
  });
});

describe('answer_question fallback', () => {
  it('uses active context instead of the generic dog-help fallback when reply is missing', async () => {
    const action = getAction('answer_question');
    expect(action).not.toBeNull();

    const ctx: ActionContext = {
      actor: { userId: 'user-1', sessionId: 'session-1' },
      threadId: 'thread-1',
      state: {},
      agentContext: baseContext,
      requestId: null,
      utterance: 'hey',
    };

    const result = await action!.def.execute({}, ctx);
    expect(result.reply).not.toBe('How can I help with your dog?');
    expect(result.reply).toContain('That looks right');
    expect(result.suggestions).toContain('That looks right');
  });
});
