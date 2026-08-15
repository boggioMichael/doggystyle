import type { AiProvider } from '../types.js';
import { decideActionHeuristic } from './controller.js';
import { explainMatchHeuristic } from './explain.js';
import { extractProfileHeuristic } from './extract.js';
import { parseIntentHeuristic } from './intent.js';
import { analyseImageHeuristic } from './media.js';

/**
 * The offline provider: deterministic, inspectable, free, and always available.
 * Also the fallback target for every remote-provider failure (see ../anthropic.ts).
 */
export const heuristicProvider: AiProvider = {
  id: 'heuristic',

  async parseIntent({ utterance, context }) {
    return parseIntentHeuristic(utterance, context);
  },

  async decideAction({ utterance, context }) {
    return decideActionHeuristic(utterance, context);
  },

  async extractProfile(input) {
    return extractProfileHeuristic(input);
  },

  async explainMatch(input) {
    return explainMatchHeuristic(input);
  },

  async analyseImage(buffer) {
    return analyseImageHeuristic(buffer);
  },
};
