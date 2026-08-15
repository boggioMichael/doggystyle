# ADR 0004 — The LLM may only call a typed, authorised action registry

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The conversational agent is the primary control surface, and it will routinely process untrusted text
(imported captions, other owners' messages). Letting a model produce database mutations — directly or
via generated SQL — would make prompt injection equivalent to account takeover.

## Decision

Define an **action registry**: a fixed map of action name → `{ inputSchema (Zod), category, handler }`.
The model's only permitted output is `{ action, args }`. The runtime then:

1. rejects unknown action names,
2. validates `args` with the action's schema (`.strict()`),
3. re-authorises against the **session** actor (never a model-supplied user id),
4. resolves any referenced ids against the actor's own current context (e.g. candidates from this
   conversation's last search),
5. for `category: 'sensitive'` actions requires an explicit human confirmation click,
6. writes an `audit_events` row.

Actions: `create_profile, update_profile, update_preferences, connect_social_account, import_media,
find_matches, show_candidate, request_introduction, accept_introduction, decline_introduction,
propose_meetup, change_meetup, cancel_meetup, send_message, block_user, report_user, delete_media,
disconnect_account`.

## Consequences

- The heuristic (offline) provider and the Anthropic provider are interchangeable: both emit the same
  action envelope, so the security posture does not depend on which model runs.
- Adding a capability is a deliberate act (new registry entry + schema + tests), not an emergent one.
