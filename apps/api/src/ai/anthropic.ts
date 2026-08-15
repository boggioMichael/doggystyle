import {
  AGENT_ACTIONS,
  MATCH_INTENTS,
  SENSITIVE_ATTRIBUTE_KEYS,
  isSensitiveAttributeKey,
} from '@doggystyle/shared';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { heuristicProvider } from './heuristic/index.js';
import { analyseImageHeuristic } from './heuristic/media.js';
import { UNTRUSTED_PREAMBLE, fenceUntrusted, redactPayload } from './redact.js';
import {
  agentDecisionSchema,
  matchExplanationSchema,
  parsedIntentSchema,
  profileExtractionSchema,
  type AiProvider,
} from './types.js';

/**
 * Anthropic-backed provider. Plain `fetch` on purpose — no SDK dependency.
 *
 * Safety posture:
 *  - Everything user- or third-party-originated is wrapped with fenceUntrusted
 *    and structured context passes through redactPayload first, so no email,
 *    coordinate, token, or address ever reaches the API (docs/THREAT_MODEL.md §6).
 *  - The model must answer with a single JSON object; the answer is Zod-validated
 *    against the same schema the heuristic provider uses, so malformed or
 *    malicious output cannot widen the action surface (ADR 0004).
 *  - ANY failure — network, timeout, bad JSON, schema violation — falls back to
 *    the deterministic heuristic implementation. The product never breaks
 *    because a remote model is down.
 *  - Image analysis ALWAYS runs locally: pixels never leave the machine (ADR 0007).
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

/* ── Transport ────────────────────────────────────────────────────────────── */

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

async function callClaude(system: string, userContent: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The key travels in a header only — it is never logged (see lib/logger.ts redact list).
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Do not include the response body in the error — it is not needed and
      // keeps any reflected content out of our logs.
      throw new Error(`anthropic api responded ${res.status}`);
    }

    const payload = (await res.json()) as { content?: AnthropicContentBlock[] };
    const text = (payload.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    if (!text.trim()) throw new Error('anthropic api returned no text content');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract the first balanced `{...}` block from model output. String-aware so
 * braces inside JSON strings do not break the scan.
 */
function extractFirstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON object in model output');
}

const JSON_ONLY =
  'Answer with a single JSON object and nothing else — no prose, no markdown fences. ' +
  'Unknown values must be null (or an empty array), never guessed.';

/* ── Provider ─────────────────────────────────────────────────────────────── */

export const anthropicProvider: AiProvider = {
  id: 'anthropic',

  async parseIntent({ utterance, context }) {
    try {
      const system = [
        UNTRUSTED_PREAMBLE,
        'You parse a dog-owner request into a structured search intent for a dog-matching product.',
        `Fields: intent (one of ${MATCH_INTENTS.join(', ')}), breedPreference, temperament[], activityLevel, sizes[], sexes[], minAgeYears, maxAgeYears, radiusKm, availability {weekday, daypart, label} or null, reproductiveStatus, freeText, confidence (0..1).`,
        JSON_ONLY,
      ].join('\n');
      const user = [
        fenceUntrusted('user_utterance', utterance),
        `Context (already redacted): ${JSON.stringify(redactPayload(context))}`,
      ].join('\n\n');
      return parsedIntentSchema.parse(extractFirstJsonObject(await callClaude(system, user)));
    } catch (err) {
      logger.warn({ err, op: 'parseIntent' }, 'anthropic provider failed — falling back to heuristic');
      return heuristicProvider.parseIntent({ utterance, context });
    }
  },

  async decideAction({ utterance, context }) {
    try {
      const system = [
        UNTRUSTED_PREAMBLE,
        'You are the dialogue policy for a dog-matchmaking assistant. Map the user utterance to exactly one action.',
        `action MUST be one of: ${AGENT_ACTIONS.join(', ')}.`,
        'Fields: action, args (object), reply (short natural sentence), suggestions (2-4 short strings), confidence (0..1).',
        'Sensitive actions are confirmed by a human before execution, so propose them when clearly requested — never invent targets that are not in the provided context.',
        JSON_ONLY,
      ].join('\n');
      const user = [
        fenceUntrusted('user_utterance', utterance),
        `Context (already redacted): ${JSON.stringify(redactPayload(context))}`,
      ].join('\n\n');
      return agentDecisionSchema.parse(extractFirstJsonObject(await callClaude(system, user)));
    } catch (err) {
      logger.warn({ err, op: 'decideAction' }, 'anthropic provider failed — falling back to heuristic');
      return heuristicProvider.decideAction({ utterance, context });
    }
  },

  async extractProfile(input) {
    try {
      const system = [
        UNTRUSTED_PREAMBLE,
        'You extract a dog profile from photo captions, owner notes, and aggregate media statistics.',
        'Fields: name, breed, breedSecondary, ageYears, sex, size, activityLevel, sociability, playStyles[], temperament[], interests[], bio (1-2 sentences), attributes[] where each item is {key, value, confidence, rationale}.',
        `NEVER output these attribute keys under any circumstances: ${SENSITIVE_ATTRIBUTE_KEYS.join(', ')}.`,
        'Only state what the captions and statistics support — do not invent facts.',
        JSON_ONLY,
      ].join('\n');
      const user = [
        // Captions come from third-party imports — fence each one individually.
        ...input.captions.slice(0, 40).map((c, i) => fenceUntrusted(`caption_${i + 1}`, c)),
        ...input.ownerNotes.slice(0, 10).map((n, i) => fenceUntrusted(`owner_note_${i + 1}`, n)),
        `Media statistics (aggregates only, no pixels): ${JSON.stringify(redactPayload(input.mediaFeatures))}`,
        `Already-known attributes: ${JSON.stringify(redactPayload(input.knownAttributes))}`,
      ].join('\n\n');
      const parsed = profileExtractionSchema.parse(extractFirstJsonObject(await callClaude(system, user)));
      // Defence in depth: strip sensitive keys even if the model ignored the
      // instruction — the DB CHECK constraint is the final backstop (ADR 0006).
      return { ...parsed, attributes: parsed.attributes.filter((a) => !isSensitiveAttributeKey(a.key)) };
    } catch (err) {
      logger.warn({ err, op: 'extractProfile' }, 'anthropic provider failed — falling back to heuristic');
      return heuristicProvider.extractProfile(input);
    }
  },

  async explainMatch(input) {
    try {
      const system = [
        UNTRUSTED_PREAMBLE,
        'You write short, friendly reasons why two dogs might get along, strictly grounded in the provided match signals.',
        'Fields: reasons (max 5 short bullets from positive signals), conflicts (max 4 warnings from hard conflicts and strongly negative signals).',
        'Use ONLY the given signals and conflicts — never invent facts about either dog.',
        JSON_ONLY,
      ].join('\n');
      // The explanation input contains only computed signals and coarse labels —
      // still redacted as a precaution before leaving the machine.
      const user = `Match data: ${JSON.stringify(redactPayload(input))}`;
      return matchExplanationSchema.parse(extractFirstJsonObject(await callClaude(system, user)));
    } catch (err) {
      logger.warn({ err, op: 'explainMatch' }, 'anthropic provider failed — falling back to heuristic');
      return heuristicProvider.explainMatch(input);
    }
  },

  /** Pixels never leave the machine — image analysis is always local (ADR 0007). */
  async analyseImage(buffer) {
    return analyseImageHeuristic(buffer);
  },
};
