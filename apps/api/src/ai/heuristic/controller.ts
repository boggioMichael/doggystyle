import type { AgentActionName, Daypart, Weekday } from '@doggystyle/shared';
import { agentDecisionSchema, type AgentContext, type AgentDecision } from '../types.js';
import {
  BREED_PATTERNS,
  DAYPART_LEXICON,
  INTENT_TERMS,
  MATING_TERMS,
  SOCIABILITY_LEXICON,
  TEMPERAMENT_LEXICON,
  WEEKDAY_LEXICON,
  containsAny,
  matchLexicon,
  normalise,
} from './lexicon.js';

/**
 * Deterministic dialogue policy: utterance → one action from AGENT_ACTIONS.
 *
 * Rules are strictly priority-ordered — the first rule that matches wins, so
 * the mapping is reproducible and testable. The action name is the security
 * boundary (ADR 0004): arguments produced here are re-validated by the action
 * executor, and sensitive actions still require a human confirmation click.
 */
export function decideActionHeuristic(utterance: string, context: AgentContext): AgentDecision {
  const raw = utterance.trim();
  const text = normalise(raw);

  /* ── 1. Pure greetings ──────────────────────────────────────────────────── */
  if (/^(?:hi|hey|hello|yo|hiya|shalom|good (?:morning|afternoon|evening))[!,. ]*$/.test(text)) {
    return greetingDecision(context);
  }

  /* ── 1b. Profile approval in plain language ─────────────────────────────── */
  if (
    context.hasDog &&
    /^(?:(?:that|this|it)(?:\s+looks?|\s+'s|\s+is)?\s+(?:right|correct|good|great|perfect)|looks?\s+(?:right|good|great|perfect)|perfect|exactly)$/i.test(raw)
  ) {
    return decision(
      'confirm_attribute',
      {
        keys: [
          'name',
          'breed',
          'breed_secondary',
          'age_years',
          'sex',
          'size',
          'activity_level',
          'sociability',
          'play_styles',
          'temperament',
          'interests',
          'bio',
        ],
      },
      'Perfect — I’ll treat the current profile draft as confirmed. You can still correct anything later just by telling me.',
      ['Find matches nearby', 'Open full profile', 'He’s actually four, not three'],
      0.9,
    );
  }

  /* ── 1c. Natural “continue / what next” follow-ups ──────────────────────── */
  if (
    /^(?:continue|go on|go ahead|carry on|keep going|what next|next step|let'?s continue)(?:[!,. ]*)$/i.test(raw) ||
    /\bcontinue with (?:my|the) dog(?: one)?\b/.test(text) ||
    /\bwhat (?:can|should) we do next\b/.test(text)
  ) {
    if (!context.hasDog) {
      return context.photoCount > 0 || context.hasConnectedSource
        ? decision('import_media', {}, 'Great — I’ll turn those photos into a profile draft now.', ['That looks right'], 0.8)
        : decision(
            'connect_social_account',
            {},
            "Absolutely — first pick where your dog's photos live, and I’ll build the profile from there.",
            ['Upload photos instead'],
            0.8,
          );
    }
    return searchDecision(context);
  }

  /* ── 2. Safety: block / report ──────────────────────────────────────────── */
  if (/\bblock\b/.test(text)) {
    const peer = findKnownDogName(text, context);
    return decision('block_user', peer ? { peerDogName: peer } : {},
      peer
        ? `I'll set up a block on ${peer}'s owner — you'll need to confirm it.`
        : "I'll set up a block — tell me which dog's owner, or confirm to block the most recent one.",
      ['Yes, block them', 'Actually, just report instead', 'Never mind'],
      0.85);
  }
  if (/\breport\b/.test(text) && !/\bweather report\b/.test(text)) {
    const peer = findKnownDogName(text, context);
    return decision('report_user', peer ? { peerDogName: peer } : {},
      "I'll prepare a report for our moderators — you'll need to confirm it and can add details.",
      ['Harassment or abuse', 'Fake profile', 'Something else'],
      0.8);
  }

  /* ── 3. Disconnect a media source ───────────────────────────────────────── */
  if (/\b(?:disconnect|unlink)\b/.test(text)) {
    const provider = detectProvider(text);
    return decision('disconnect_account', provider ? { provider } : {},
      provider
        ? `I'll disconnect ${providerLabel(provider)} — imported photos stay unless you delete them.`
        : "I'll disconnect your media source — imported photos stay unless you delete them.",
      ['Yes, disconnect', 'Keep it connected'],
      0.85);
  }

  /* ── 4. Connect a media source / upload photos ──────────────────────────── */
  if (
    /\b(?:connect|link|sync)\b.*\b(?:instagram|insta|google|photos?|account|source)\b/.test(text) ||
    /\bupload\b.*\b(?:photos?|pictures?|pics?)\b/.test(text) ||
    /\bupload photos instead\b/.test(text)
  ) {
    const provider = detectProvider(text) ?? (/\bupload\b/.test(text) ? 'upload' : null);
    return decision('connect_social_account', provider ? { provider } : {},
      provider === 'upload'
        ? "Sure — upload a few photos of your dog and I'll build a profile draft from them."
        : `Let's connect ${provider ? providerLabel(provider) : 'a photo source'} so I can build your dog's profile from real photos.`,
      ['Connect Instagram', 'Connect Google Photos', 'Upload photos instead'],
      0.85);
  }

  /* ── 5. Delete a photo ──────────────────────────────────────────────────── */
  if (/\b(?:remove|delete)\b[^.]*\b(?:photos?|pictures?|pics?|images?)\b/.test(text)) {
    const ordinal = parseOrdinal(text);
    return decision('delete_media', ordinal !== null ? { ordinal } : {},
      ordinal !== null
        ? `I'll delete photo ${ordinal === -1 ? '(the last one)' : `#${ordinal}`} — please confirm.`
        : "I'll delete that photo — please confirm which one.",
      ['Yes, delete it', 'Show my photos first', 'Keep it'],
      0.85);
  }

  /* ── 6. Location privacy ────────────────────────────────────────────────── */
  if (
    /\b(?:hide|don'?t show|do not show|never show)\b[^.]*\blocation\b/.test(text) ||
    /\bexact location\b[^.]*\b(?:hide|off|private)\b/.test(text)
  ) {
    return decision('update_profile', { updates: [{ key: 'location_precision', value: 'city' }] },
      "Done — peers will only ever see your city, never an exact location.",
      ['Show my profile', 'Update my preferences'],
      0.9);
  }

  /* ── 7. Moved city ──────────────────────────────────────────────────────── */
  const moved = raw.match(/\bwe (?:just |recently )?moved to ([A-Za-z][A-Za-z'’\- ]{1,40})/i);
  if (moved?.[1]) {
    const city = moved[1].replace(/[.,!?].*$/, '').trim();
    return decision('update_profile', { updates: [{ key: 'city', value: city }] },
      `Congrats on the move! I'll update your location to ${city} — matches will come from there now.`,
      ['Find dogs near our new home', 'Update my search radius'],
      0.85);
  }

  /* ── 8. Standing radius preference: "only find dogs within N km" ────────── */
  const prefRadius = text.match(
    /\bonly (?:find|show|search)\b[^.]*\b(?:within|inside|closer than|under)\s*(\d{1,3}(?:\.\d)?)\s*(?:km|kilomet(?:er|re)s?)\b/,
  );
  if (prefRadius?.[1]) {
    const radiusKm = Number(prefRadius[1]);
    return decision('update_preferences', { radiusKm },
      `Got it — from now on I'll only look for dogs within ${radiusKm} km.`,
      ['Search again with the new radius', 'Show my preferences'],
      0.85);
  }

  /* ── 9. One-off radius refinement of the last search ────────────────────── */
  if (
    context.lastSearchId &&
    /\b(?:closer than|within|less than|no more than)\s*\d{1,3}(?:\.\d)?\s*(?:km|kilomet(?:er|re)s?)\b/.test(text)
  ) {
    // The intent parser re-reads the utterance, so no args are needed here.
    return decision('find_matches', {},
      'Tightening the search — one moment.',
      ['Show me another', 'Widen it again'],
      0.8);
  }

  /* ── 10. Accept / decline a pending introduction ────────────────────────── */
  const mentionsIntro = /\b(?:intro(?:duction)?s?|request)\b/.test(text);
  if (
    /\b(?:accept|approve|say yes|yes to)\b/.test(text) &&
    (mentionsIntro || context.pendingIntroductions > 0)
  ) {
    return decision('accept_introduction', {},
      "Lovely — I'll accept the introduction and open a conversation with the other owner.",
      ['Send them a hello', 'Propose a meetup'],
      0.85);
  }
  if (
    /\b(?:decline|reject|say no|no to|turn (?:it |that )?down|not interested)\b/.test(text) &&
    (mentionsIntro || context.pendingIntroductions > 0)
  ) {
    return decision('decline_introduction', {},
      "No problem — I'll politely decline. They won't see a reason.",
      ['Show me other matches', 'Adjust my preferences'],
      0.85);
  }

  /* ── 11. Cancel / reschedule a meetup ───────────────────────────────────── */
  if (/\bcancel\b[^.]*\b(?:meet ?up|meeting|playdate|walk)\b/.test(text) || /\bcall (?:it|the meetup) off\b/.test(text)) {
    return decision('cancel_meetup', {},
      "I'll cancel the meetup and let the other owner know — please confirm.",
      ['Yes, cancel it', 'Reschedule instead'],
      0.85);
  }
  if (/\b(?:reschedule|postpone|move|change)\b[^.]*\b(?:meet ?up|meeting|playdate|time)\b/.test(text)) {
    const when = parseWhenLabel(text);
    return decision('change_meetup', when ? { when } : {},
      when ? `I'll propose moving the meetup to ${when}.` : 'Sure — when would suit you better?',
      ['Saturday morning', 'Sunday afternoon', 'Next week'],
      0.8);
  }

  /* ── 12. Propose a meetup (explicit verbs) ──────────────────────────────── */
  if (/\b(?:arrange|schedule|organi[sz]e|set up|plan)\b[^.]*\b(?:meet ?up|meeting|playdate|walk|date)\b/.test(text) || /\bmeet ?up\b/.test(text)) {
    if (context.openConnections.length === 0) {
      return decision('answer_question', {},
        'Meetups happen with connected dogs — once an introduction is accepted I can arrange one. Shall we find some matches first?',
        ['Find matches nearby', 'Show my introductions'],
        0.7);
    }
    const when = parseWhenLabel(text);
    const peer = findConnectionDogName(text, context);
    const args: Record<string, unknown> = { when: when ?? null };
    if (peer) args.connectionPeer = peer;
    return decision('propose_meetup', args,
      `On it — drafting a meetup${peer ? ` with ${peer}` : ''}${when ? ` for ${when}` : ''} at a public spot roughly halfway.`,
      ['Suggest a dog park', 'Different time', 'Send it'],
      0.85);
  }

  /* ── 13. Send a message to a connected owner ────────────────────────────── */
  const tell = raw.match(/\btell\s+([A-Za-z]+)['’]s owner\s+(?:that\s+)?(.{2,500})/i);
  if (tell?.[1] && tell[2]) {
    const peer = findConnectionDogName(normalise(tell[1]), context) ?? tell[1];
    return decision('send_message', { peerDogName: peer, body: tell[2].trim() },
      `I'll send that to ${peer}'s owner — confirm and it goes out.`,
      ['Send it', 'Reword it', 'Never mind'],
      0.85);
  }
  const reply = raw.match(/\breply\s+(?:with\s+|saying\s+|that\s+)?(.{2,500})/i);
  if (reply?.[1]) {
    return decision('send_message', { peerDogName: null, body: reply[1].trim() },
      "I'll send that reply in your most recent conversation — confirm and it goes out.",
      ['Send it', 'Reword it'],
      0.8);
  }

  /* ── 14. Request an introduction ────────────────────────────────────────── */
  const introDecision = matchIntroduction(raw, text, context);
  if (introDecision) return introDecision;

  /* ── 15. Show the next candidate ────────────────────────────────────────── */
  if (
    context.lastSearchId &&
    (/\bshow (?:me )?(?:another|more|the next|next)\b/.test(text) ||
      /\banother one\b|\bwho else\b|\bnext\b|\bany(?:one|body) else\b/.test(text))
  ) {
    return decision('show_candidate', { next: true },
      "Here's the next one.",
      ['I like this one', 'Show me another', 'Refine the search'],
      0.85);
  }

  /* ── 15b. Build / rebuild the profile from imported photos ──────────────── */
  if (
    /\b(?:build|create|make|generate|set ?up|fill in|work out)\b[^.]*\b(?:profile|his profile|her profile|their profile)\b/.test(text) ||
    /\b(?:use|from)\b[^.]*\b(?:imported|uploaded|my)\b[^.]*\b(?:photos?|pictures?|pics?|images?)\b/.test(text) ||
    /\bwhich (?:photos?|ones?) (?:are|is) (?:my|the) dog\b/.test(text)
  ) {
    return decision(
      'import_media',
      {},
      'Looking through your photos now…',
      ['That looks right', 'Change the breed', 'Find matches nearby'],
      0.85,
    );
  }

  /* ── 16. Explicit search verbs ──────────────────────────────────────────── */
  if (/\b(?:find|looking for|look for|search|show me (?:some )?dogs?|any dogs?)\b/.test(text) || /\bmatch(?:es)?\b/.test(text)) {
    return searchDecision(context);
  }

  /* ── 17. Profile corrections (only when a profile exists) ───────────────── */
  if (context.hasDog) {
    const correction = matchProfileCorrection(raw, text, context);
    if (correction) return correction;
  }

  /* ── 18. Implicit search: intent vocabulary ─────────────────────────────── */
  if (
    containsAny(text, MATING_TERMS) ||
    Object.values(INTENT_TERMS).some((terms) => containsAny(text, terms))
  ) {
    return searchDecision(context);
  }

  /* ── 19. Bare time mention with open connections → meetup ───────────────── */
  if (context.openConnections.length > 0) {
    const when = parseWhenLabel(text);
    if (when) {
      const peer = findConnectionDogName(text, context);
      const args: Record<string, unknown> = { when };
      if (peer) args.connectionPeer = peer;
      return decision('propose_meetup', args,
        `${capitalise(when)} works? I'll draft a meetup${peer ? ` with ${peer}` : ''} for then.`,
        ['Yes, propose it', 'Different time'],
        0.65);
    }
  }

  /* ── 20. Everything else: answer helpfully with the next best step ──────── */
  return fallbackDecision(context);
}

/* ── Decision helpers ─────────────────────────────────────────────────────── */

function decision(
  action: AgentActionName,
  args: Record<string, unknown>,
  reply: string,
  suggestions: string[],
  confidence: number,
): AgentDecision {
  return agentDecisionSchema.parse({ action, args, reply, suggestions: suggestions.slice(0, 4), confidence });
}

function searchDecision(context: AgentContext): AgentDecision {
  if (!context.hasDog) {
    // Cannot search without a subject dog. Return the connect action rather than
    // plain text so the reply carries the actual source picker, not just advice.
    return decision('connect_social_account', {},
      "I'd love to — but first I need to know your dog! Pick where their photos live and I'll build the profile, then find great matches nearby.",
      ['Upload photos instead'],
      0.7);
  }
  const who = context.dogName ?? 'your dog';
  return decision('find_matches', {},
    `On it — searching for good matches for ${who} near ${context.city ?? 'you'}.`,
    ['Show me another', 'Only dogs within 5 km', 'Calmer dogs please'],
    0.85);
}

function greetingDecision(context: AgentContext): AgentDecision {
  if (!context.hasDog) {
    return decision('answer_question', {},
      "Hi! I help your dog make friends: connect a photo source and I'll build their profile, you confirm it, then I find compatible dogs nearby and handle the introductions.",
      ['Connect a photo source', 'Upload photos instead', 'What can you do?'],
      0.75);
  }
  const name = context.dogName ?? 'your dog';
  return decision('answer_question', {},
    `Hi! Ready when you are — I can find matches for ${name}, arrange introductions, or set up a meetup.`,
    ['Find a walking buddy', 'Show my introductions', 'Propose a meetup'],
    0.75);
}

function fallbackDecision(context: AgentContext): AgentDecision {
  if (!context.hasDog) {
    if (context.photoCount > 0 || context.hasProfileDraft) {
      return decision('answer_question', {},
        "Next step: confirm your dog's profile draft — I've already pulled together what I could from the photos. Once you confirm it, I can start matching.",
        ['Review the profile draft', 'Import more photos'],
        0.5);
    }
    return decision('connect_social_account', {},
      "Here's how it works: connect a photo source, I build your dog's profile from the photos, you confirm it, and then I find compatible dogs nearby. Where shall we start?",
      ['Upload photos instead', 'What can you do?'],
      0.4);
  }
  if (!context.lastSearchId) {
    const name = context.dogName ?? 'your dog';
    if (context.photoCount > 0 || context.hasProfileDraft) {
      return decision('answer_question', {},
        `If ${name}'s profile looks right, say “That looks right” and I’ll start matching. Or correct anything in plain language and I’ll update it.`,
        ['That looks right', 'He’s actually four, not three', 'Find matches nearby'],
        0.45);
    }
    return decision('answer_question', {},
      `Tell me what you'd like for ${name} — a walking buddy, a playdate, a running partner — and I'll find nearby dogs that fit. You can be picky: size, energy, distance, schedule.`,
      ['Find a friendly walking buddy', 'Find an energetic playmate', 'Update my preferences'],
      0.4);
  }
  return decision('answer_question', {},
    "I can show more candidates, ask another owner for an introduction, or set up a meetup with one of your connections. What would you like?",
    ['Show me another match', 'Propose a meetup', 'Update my preferences'],
    0.4);
}

/* ── Introduction matching ────────────────────────────────────────────────── */

function matchIntroduction(raw: string, text: string, context: AgentContext): AgentDecision | null {
  const wantsIntro =
    /\bintroduc/.test(text) ||
    /\bask\b[^.]*\bowner\b/.test(text) ||
    /\bset us up\b|\bmake the intro\b/.test(text);

  // "I like <Name>" only counts when <Name> is a candidate we actually showed.
  const liked = raw.match(/\bi (?:like|love|want)\s+([A-Za-z]+)\b/i);
  const likedName = liked?.[1] ? findCandidateName(normalise(liked[1]), context) : null;

  if (!wantsIntro && !likedName) return null;

  if (context.lastCandidateNames.length === 0 && !likedName) {
    return decision('answer_question', {},
      "There's no candidate on the table yet — let's search first, then I can ask an owner for an introduction.",
      ['Find matches nearby'],
      0.6);
  }

  // Explicit name in the utterance wins; null means "the most recent one shown".
  const named = likedName ?? findCandidateName(text, context);
  return decision('request_introduction', { candidateName: named ?? null },
    named
      ? `Great choice — I'll ask ${named}'s owner for an introduction. You'll need to confirm before anything is sent.`
      : "I'll ask that owner for an introduction — confirm and I'll send it.",
    ['Yes, send the request', 'Add a personal note', 'Show me another first'],
    0.85);
}

/* ── Profile corrections ──────────────────────────────────────────────────── */

function matchProfileCorrection(raw: string, text: string, context: AgentContext): AgentDecision | null {
  const dogName = context.dogName ?? 'your dog';

  // Name: "his name is Rex", "call her Luna", "the name's actually Biscuit"
  const nameMatch =
    raw.match(/\b(?:his|her|their|the) name(?:'s| is)\s+(?:actually\s+)?([A-Z][a-z]{1,11})\b/) ??
    raw.match(/\bcall (?:him|her|them)\s+([A-Z][a-z]{1,11})\b/);
  if (nameMatch?.[1]) {
    return decision('update_profile', { updates: [{ key: 'name', value: nameMatch[1] }] },
      `Noted — ${nameMatch[1]} it is. I've updated the profile.`,
      ['Show the profile', 'Find matches'],
      0.85);
  }

  // Age: "he's actually 4", "she is 3 years old", "he's actually four, not three"
  const ageMatch = text.match(
    /\b(?:he|she|it)(?:'s| is)\s+(?:actually\s+|only\s+)?(\d{1,2}(?:\.\d)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s*(?:years?|yrs?)?\s*(?:old)?\b/,
  );
  if (ageMatch?.[1] && /(?:actually|only|years?|yrs?|old|not)/.test(text)) {
    const age = parseNumberWord(ageMatch[1]);
    if (age !== null && age >= 0 && age <= 30) {
      return decision('update_profile', { updates: [{ key: 'age_years', value: age }] },
        `Thanks — I've set ${dogName}'s age to ${age}.`,
        ['Show the profile', 'Anything else to fix?'],
        0.85);
    }
  }

  // Sex: "he's a boy", "she is female"
  const sexMatch = text.match(/\b(?:he|she|it)(?:'s| is)\s+(?:a\s+)?(boy|girl|male|female)\b/);
  if (sexMatch?.[1]) {
    const value = sexMatch[1] === 'boy' || sexMatch[1] === 'male' ? 'male' : 'female';
    return decision('update_profile', { updates: [{ key: 'sex', value }] },
      `Got it — marked ${dogName} as ${value}.`,
      ['Show the profile'],
      0.85);
  }

  // Breed: "he's actually a border collie", "she is a labradoodle"
  if (/\b(?:he|she|it|actually)(?:'s| is)?\b[^.]*\b(?:a|an)\b/.test(text)) {
    const breed = findBreedMention(text);
    if (breed) {
      return decision('update_profile', { updates: [{ key: 'breed', value: breed }] },
        `Updated — ${dogName} is a ${breed}.`,
        ['Show the profile', 'Find matches'],
        0.8);
    }
  }

  // Good-with statements: "friendly with small dogs but nervous around large dogs"
  const updates = parseTraitUpdates(text);
  if (updates.length) {
    return decision('update_profile', { updates },
      `Thanks, that really helps matching — I've noted ${summariseUpdates(updates)}.`,
      ['Show the profile', 'Find compatible dogs'],
      0.8);
  }

  return null;
}

const POSITIVE_TERMS = ['friendly', 'good', 'great', 'fine', 'gentle', 'loves', 'adores', 'happy', 'comfortable', 'ok with', 'okay'];
const NEGATIVE_TERMS = ['nervous', 'scared', 'afraid', 'anxious', 'wary', 'reactive', 'aggressive', 'not good', 'no good', 'uncomfortable', 'hates', 'avoid'];

const GOOD_WITH_TARGETS: Array<{ key: string; patterns: string[] }> = [
  { key: 'good_with_small_dogs', patterns: ['small dogs', 'little dogs', 'tiny dogs', 'small breeds'] },
  { key: 'good_with_large_dogs', patterns: ['large dogs', 'big dogs', 'giant dogs', 'large breeds'] },
  { key: 'good_with_puppies', patterns: ['puppies', 'young dogs'] },
  { key: 'good_with_kids', patterns: ['kids', 'children', 'toddlers'] },
];

/** Sentiment within ~40 chars before the mention decides the boolean. */
function parseTraitUpdates(text: string): Array<{ key: string; value: unknown }> {
  const updates: Array<{ key: string; value: unknown }> = [];

  for (const target of GOOD_WITH_TARGETS) {
    for (const pattern of target.patterns) {
      const idx = text.indexOf(pattern);
      if (idx === -1) continue;
      const window = text.slice(Math.max(0, idx - 40), idx);
      const negative = NEGATIVE_TERMS.some((t) => window.includes(t));
      const positive = POSITIVE_TERMS.some((t) => window.includes(t));
      if (negative) updates.push({ key: target.key, value: false });
      else if (positive) updates.push({ key: target.key, value: true });
      break;
    }
  }

  // Only attach temperament/sociability when the sentence is about the dog.
  if (/\b(?:he|she|it|my dog)(?:'s| is| can be| gets)\b/.test(text) || updates.length > 0) {
    const temperament = matchLexicon(text, TEMPERAMENT_LEXICON, { respectNegation: true });
    if (temperament.length) updates.push({ key: 'temperament', value: temperament });
    const sociability = matchLexicon(text, SOCIABILITY_LEXICON, { respectNegation: true })[0];
    if (sociability) updates.push({ key: 'sociability', value: sociability });
  }

  return updates;
}

function summariseUpdates(updates: Array<{ key: string; value: unknown }>): string {
  return updates
    .map((u) => {
      if (typeof u.value === 'boolean') return `${u.key.replaceAll('_', ' ')}: ${u.value ? 'yes' : 'no'}`;
      if (Array.isArray(u.value)) return `${u.key.replaceAll('_', ' ')}: ${u.value.join(', ')}`;
      return `${u.key.replaceAll('_', ' ')}: ${String(u.value)}`;
    })
    .join('; ');
}

/* ── Small parsers ────────────────────────────────────────────────────────── */

const WEEKDAY_LABELS: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

const DAYPART_WORDS: Record<Daypart, string> = {
  early_morning: 'early morning',
  morning: 'morning',
  midday: 'midday',
  afternoon: 'afternoon',
  evening: 'evening',
  night: 'night',
};

/** "saturday afternoon" → a human availability label, or null. */
function parseWhenLabel(text: string): string | null {
  if (/\bthis weekend\b|\bweekend\b/.test(text)) return 'this weekend';
  if (/\btomorrow\b/.test(text)) return 'tomorrow';
  const weekday = matchLexicon<Weekday>(text, WEEKDAY_LEXICON)[0] ?? null;
  const daypart = matchLexicon<Daypart>(text, DAYPART_LEXICON)[0] ?? null;
  if (!weekday && !daypart) return null;
  return [weekday ? WEEKDAY_LABELS[weekday] : null, daypart ? DAYPART_WORDS[daypart] : null]
    .filter(Boolean)
    .join(' ');
}

function parseOrdinal(text: string): number | null {
  const words: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 };
  for (const [word, n] of Object.entries(words)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  }
  const numbered = text.match(/\b(?:photo|picture|pic|image|number)\s*#?\s*(\d{1,3})\b/);
  if (numbered?.[1]) return Number(numbered[1]);
  return null;
}

/** Case-insensitive lookup against the candidates shown in the last search. */
function findCandidateName(text: string, context: AgentContext): string | null {
  for (const name of context.lastCandidateNames) {
    if (name && new RegExp(`\\b${escapeRegExp(normalise(name))}\\b`).test(text)) return name;
  }
  return null;
}

/** Case-insensitive lookup against connected peers' dog names. */
function findConnectionDogName(text: string, context: AgentContext): string | null {
  for (const conn of context.openConnections) {
    if (conn.peerDogName && new RegExp(`\\b${escapeRegExp(normalise(conn.peerDogName))}\\b`).test(text)) {
      return conn.peerDogName;
    }
  }
  return null;
}

/** Any dog name the user can legitimately refer to (candidates or connections). */
function findKnownDogName(text: string, context: AgentContext): string | null {
  return findCandidateName(text, context) ?? findConnectionDogName(text, context);
}

function findBreedMention(text: string): string | null {
  let best: { name: string; pattern: string } | null = null;
  for (const b of BREED_PATTERNS) {
    for (const p of b.patterns) {
      if (best && p.length <= best.pattern.length) continue;
      if (new RegExp(`\\b${escapeRegExp(p)}\\b`).test(text)) best = { name: b.name, pattern: p };
    }
  }
  return best?.name ?? null;
}

function detectProvider(text: string): string | null {
  if (/\binsta(?:gram)?\b/.test(text)) return 'instagram';
  if (/\bgoogle\b/.test(text)) return 'google_photos';
  if (/\barchive\b|\bzip\b|\bexport\b/.test(text)) return 'archive';
  if (/\bupload\b/.test(text)) return 'upload';
  if (/\bdemo\b/.test(text)) return 'demo';
  return null;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case 'instagram':
      return 'Instagram';
    case 'google_photos':
      return 'Google Photos';
    case 'archive':
      return 'your photo archive';
    case 'upload':
      return 'uploads';
    default:
      return provider;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const capitalise = (s: string): string => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Owners write ages both ways ("he's 4", "he's actually four"), so accept
 * spelled-out numbers up to twenty alongside digits.
 */
function parseNumberWord(input: string): number | null {
  const direct = Number(input);
  if (Number.isFinite(direct)) return direct;
  const words: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20,
  };
  return words[input.toLowerCase()] ?? null;
}
