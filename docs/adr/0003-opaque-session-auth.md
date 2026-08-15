# ADR 0003 — Opaque server-side sessions over JWT

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

We need revocable authentication, an admin console, account deletion, and protection against XSS
token theft — for a product whose worst-case failure is physical stalking.

## Decision

Opaque 32-byte random session tokens stored **hashed (SHA-256 + pepper)** in `sessions`, delivered in
an `httpOnly`, `SameSite=Lax` cookie. CSRF handled by a double-submit token in a second,
JS-readable cookie that must be echoed in `x-csrf-token` on every non-GET request. Magic-link
(passwordless) and argon2id password login both mint the same session type.

## Rationale

- Instant revocation (logout-everywhere, account deletion, admin ban) — impossible with stateless JWT
  without a denylist that reintroduces the same DB lookup.
- `httpOnly` removes the largest XSS payoff.
- Same-origin deployment (Caddy) makes cookies simpler and safer than bearer tokens in JS.

## Consequences

- One indexed DB read per authenticated request. Measured at <1 ms locally; acceptable well past MVP.
- A future mobile app can use the same session token as a bearer header — the auth plugin accepts
  both `Cookie` and `Authorization: Bearer`.
