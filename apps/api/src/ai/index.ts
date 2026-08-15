import { env } from '../config/env.js';
import { anthropicProvider } from './anthropic.js';
import { heuristicProvider } from './heuristic/index.js';
import type { AiProvider } from './types.js';

/**
 * Provider selection. The heuristic provider is the default and the guaranteed
 * fallback: the Anthropic provider is only offered when it is both requested
 * AND actually usable (a key is present), so a misconfigured deployment
 * degrades to the offline provider instead of failing every AI call.
 */
export function getAiProvider(): AiProvider {
  if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY.trim().length > 0) {
    return anthropicProvider;
  }
  return heuristicProvider;
}

export type { AiProvider } from './types.js';
