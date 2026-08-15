# ADR 0005 — Deterministic matching; AI explains, never ranks

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Matching quality must be testable, reproducible and debuggable. It must also produce human
explanations. Those two goals conflict if a model does the ranking.

## Decision

Three strictly ordered stages:

1. **Hard constraints in SQL** — distance, sex, breed, age range, reproductive status, blocks,
   visibility, availability, intent compatibility. Anything violating these never reaches scoring.
2. **Soft scoring — a pure, deterministic function** over structured profile data producing a score
   plus a per-signal contribution breakdown. Unit-tested with fixed fixtures.
3. **Explanation** — the AI receives *only* the computed signal contributions and phrases them. It
   cannot reorder, add or remove candidates. With `AI_PROVIDER=heuristic` a template does the same job.

## Consequences

- Match results are identical run-to-run for the same inputs; regressions are caught by unit tests.
- Explanations are always grounded in a number that actually influenced the ranking.
- Improving ranking means changing weights in one tested file, not prompt-tuning.
