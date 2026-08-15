# ADR 0007 — Offline-first AI: heuristic provider is the default

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The product owner must be able to run the entire experience immediately, with no API keys, no
account creation and no per-token cost (cost policy §31). But quality should improve when a key is
available.

## Decision

One `AiProvider` interface with five task methods. Two implementations:

- `heuristic` (**default**) — deterministic, local, zero-cost: a breed/temperament lexicon, a
  grammar-driven intent parser, template explanations, and `sharp`-based image statistics for
  dog-likeness, visual signature and quality scoring.
- `anthropic` — used when `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` is set.

Every provider call is Zod-validated, time-bounded, and **falls back to the heuristic implementation**
on error, timeout or schema violation. All payloads pass through `ai/redact.ts` first.

## Consequences

- Tests are fast and hermetic; CI needs no secrets.
- The product never hard-fails because a model is unavailable — it degrades in phrasing quality only.
- Match ranking is unaffected by provider choice (ADR 0005), so switching providers cannot change
  who is shown to whom.
