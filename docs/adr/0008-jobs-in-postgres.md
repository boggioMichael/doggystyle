# ADR 0008 — Background jobs in Postgres, not Redis/BullMQ

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The media pipeline (import → normalise → dedupe → classify → cluster → score → select → extract) must
be asynchronous, resumable and observable. Adding Redis would add a service, a failure mode and a
second source of truth.

## Decision

A `jobs` table consumed by a worker loop using
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` inside a transaction. Attempts, backoff, `dead_letter`
state, payload and error are columns. The worker runs as a separate Compose service using the same
image with `ROLE=worker` (and in-process during `npm run dev` for convenience).

## Rationale

At MVP volumes (hundreds of jobs/day) Postgres queueing is well within capacity, gives transactional
enqueue-with-your-write semantics, and makes the admin job view a plain SQL query.

## Consequences

- Add Redis/BullMQ only when a concrete throughput or latency problem appears; the `JobQueue`
  interface makes that a single-file swap.
- Job visibility comes free in the admin console.
