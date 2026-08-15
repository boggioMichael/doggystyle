# ADR 0006 — Every profile attribute carries provenance; sensitive facts are never inferred

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The product auto-generates profiles from photos and captions. Some attributes (breed, size, activity)
are reasonable to infer. Others (health, genetics, pedigree, reproductive status, vaccination) are
not — inferring them from a photograph would be misleading and potentially harmful.

## Decision

Attributes live in `dog_profile_attributes` as
`(dog_id, key) → value_json, source, confidence, user_confirmed, observed_at, updated_at`, with
`source ∈ {vision_model, text_model, social_import, user, verified_document, system_default}`.

A `SENSITIVE_KEYS` set (health/genetic/pedigree/reproductive/vet) is enforced **twice**:

- in the service layer, which rejects writes with a model source, and
- by a database `CHECK` constraint, so no code path can bypass it.

Unknown stays unknown: absence is represented explicitly and rendered as "not provided yet", never
as a guess. The UI badges every unconfirmed value and offers one-tap confirmation.

## Consequences

- Mating results report **data completeness**, not an AI compatibility percentage (see PRODUCT_SPEC §9).
- Every attribute change is auditable and reversible via `dog_profile_attribute_history`.
