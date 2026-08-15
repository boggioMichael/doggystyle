# ADR 0001 — Stack selection

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Greenfield product that must run as a production-like system on a single Windows 11 laptop
(8 logical cores, 15 GB RAM), be operable by a non-programmer via one command, and be able to move to
cloud infrastructure later without a rewrite.

## Decision

TypeScript everywhere. **Fastify 5** API, **React 19 + Vite 7 + Tailwind 4** web, **PostgreSQL 16**,
**Drizzle ORM**, **Docker Compose** orchestration, **Caddy** reverse proxy on a single origin,
**Vitest + Playwright** for tests.

## Rationale

- One language across API, web, shared types and tests → fastest iteration for a solo team.
- Fastify gives schema-first validation and a small surface; NestJS adds DI ceremony we do not need.
- Single origin via Caddy removes CORS entirely and makes `SameSite=Lax` cookies viable.
- Compose maps 1:1 to the "one bootstrap command" requirement.

## Consequences

- Node is a hard dependency for local dev outside Docker (acceptable, already installed).
- We forgo Nest's opinionated structure; module boundaries are enforced by convention + lint.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Next.js full-stack | Couples web and API; harder to reuse the backend from a future mobile app |
| NestJS | Heavier than needed for this scope |
| Kubernetes | Solves no problem present here; explicitly excluded by the product owner |
| Go/Python backend | Loses shared types with the frontend |
