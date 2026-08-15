import { matchExplanationSchema, type MatchExplanation, type MatchExplanationInput } from '../types.js';

/**
 * Turn computed match signals into short human-readable bullets.
 *
 * Grounding rule: every sentence here is derived from a signal the matching
 * engine actually computed (or a hard conflict it flagged). Nothing is
 * invented, so the explanation can never claim something the data does not
 * support.
 */

/** Signals below this contribution are too weak to present as a reason. */
const REASON_THRESHOLD = 0.15;
/** Signals below this contribution are worth surfacing as a warning. */
const CONFLICT_THRESHOLD = -0.25;

const MAX_REASONS = 5;
const MAX_CONFLICTS = 4;

export function explainMatchHeuristic(input: MatchExplanationInput): MatchExplanation {
  /* ── Reasons: strongest weighted positive signals first ─────────────────── */
  const reasons = [...input.signals]
    .filter((s) => s.contribution > REASON_THRESHOLD)
    .sort((a, b) => b.contribution * b.weight - a.contribution * a.weight)
    .slice(0, MAX_REASONS)
    .map((s) => tidySentence(s.detail || s.label));

  /* ── Conflicts: hard conflicts verbatim, then strongly negative signals ─── */
  const conflicts: string[] = [];
  for (const hard of input.hardConflicts) {
    if (conflicts.length >= MAX_CONFLICTS) break;
    const text = tidySentence(hard);
    if (text && !conflicts.includes(text)) conflicts.push(text);
  }

  const negatives = [...input.signals]
    .filter((s) => s.contribution < CONFLICT_THRESHOLD)
    .sort((a, b) => a.contribution * a.weight - b.contribution * b.weight);
  for (const s of negatives) {
    if (conflicts.length >= MAX_CONFLICTS) break;
    const text = `Heads up: ${lowerFirst(tidySentence(s.detail || s.label))}`;
    if (!conflicts.includes(text)) conflicts.push(text);
  }

  return matchExplanationSchema.parse({
    reasons: dedupe(reasons),
    conflicts,
  });
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function tidySentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capitalised = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised.slice(0, -1) : capitalised;
}

function lowerFirst(text: string): string {
  return text.length ? text[0]!.toLowerCase() + text.slice(1) : text;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
