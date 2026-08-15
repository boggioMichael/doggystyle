# Doggystyle — Product Specification

> Internal working name: **Doggystyle**. Branding is centralised in
> `packages/shared/src/branding.ts` and `.env` (`BRAND_NAME`), so it can be changed in one place.

## 1. One-line pitch

**Tell us what you want for your dog. We do the rest.**

Doggystyle is a conversational service for dog owners. Instead of filling in a profile form and
swiping, the owner types what they want — *"find my dog a calm walking buddy nearby this weekend"* —
and the system builds the dog's profile, finds compatible dogs, explains why, and helps arrange the
meetup.

## 2. Problem

Existing dog-social products fail on three axes:

| Problem | Consequence |
| --- | --- |
| Profile creation is a chore (20+ fields) | Sparse, stale profiles; cold-start failure |
| Matching is appearance-first swiping | Bad meetups; owners churn |
| Coordination happens off-platform | No feedback loop, no network effects |

## 3. Target users

1. **Casual owner** — wants their dog to have friends, walks, playdates. Low effort tolerance.
2. **Active owner** — running/hiking partner for a high-energy dog. Cares about activity match.
3. **Responsible breeder / considering-litter owner** — wants a *mating* match. Cares about breed,
   pedigree, health screening, reproductive status. Needs a fundamentally different flow.
4. **Newcomer to a city** — wants to meet owners with similar dogs.

## 4. Product principles

1. **Conversation is the control surface.** Dashboards are a fallback, not the default.
2. **Zero-effort onboarding.** The system proposes; the owner confirms or corrects.
3. **Never invent facts.** Inferred attributes carry provenance and confidence and are visibly
   *unconfirmed* until the owner says otherwise. Health, genetics, pedigree and reproductive facts
   are **never** inferred — only owner-entered or verified.
4. **Consent before contact.** Discovery is automated; introductions are mutual.
5. **Coarse location by default.** Exact coordinates are never returned by any public API.
6. **Compliant integrations only.** Official APIs, OAuth, user-authorised exports, direct uploads.
   No scraping, no password collection, no anti-bot circumvention.

## 5. Core user journeys

### J1 — First run (the "definition of done" path)

```
Landing page (single prompt box)
 → user types an objective (optionally) and signs up
 → connect a media source (mock/demo provider, upload, or authorised archive)
 → media pipeline classifies dog content, clusters per-dog, scores quality
 → AI proposes a complete dog profile (every field with source + confidence)
 → owner corrects conversationally ("he's actually four", "remove that second photo")
 → owner states an objective ("find a compatible dog nearby for a playdate")
 → intent parser → structured search → hard filter → soft ranking → explanations
 → owner refines ("only dogs closer than 5km", "show me another")
 → owner requests an introduction
 → other owner accepts (real, or simulated in demo mode)
 → conversation unlocks; owners message
 → meetup proposed, accepted, scheduled
```

### J2 — Mating search

Explicitly separate intent. The system:
- requires the owner to opt into `mating` intent,
- requires structured breeding data (exact breed, DOB, sex, reproductive status) as **hard**
  constraints,
- surfaces *completeness* of health/genetic/pedigree information rather than a compatibility score,
- shows a persistent disclaimer that the product is a discovery tool, **not** veterinary or breeding
  approval.

### J3 — Conversational profile editing

Natural language → typed action → validated mutation → audit event. Examples supported:

| Utterance | Action |
| --- | --- |
| "He's actually four, not three." | `update_profile` age_years=4, user_confirmed |
| "Remove that second picture." | `delete_media` |
| "Friendly with small dogs, nervous around large dogs." | `update_profile` temperament + restrictions |
| "We moved to Haifa." | `update_profile` location (coarse) |
| "Don't show his exact location." | `update_profile` privacy.location_precision=city |
| "Only find dogs within 15 kilometres." | `update_preferences` radius_km=15 |

### J4 — Meetup coordination

Propose → counter-propose → accept → remind → reschedule/cancel. Location is a *suggested area*
(midpoint between two coarse locations, snapped to a public place) and is only revealed after both
sides accept.

## 6. Feature scope

### In scope for MVP (local release)

- Email+password and passwordless magic-link auth, sessions, CSRF, rate limiting, logout, deletion
- Dog profiles with per-attribute provenance (`value / source / confidence / user_confirmed / at`)
- Media upload + processing pipeline + per-dog clustering + profile-photo selection
- Social provider adapter layer with a working **demo** provider and **upload/archive** providers;
  Instagram + Google Photos adapters implemented behind feature flags pending credentials
- Conversational agent with a **typed, validated action registry** (the model never touches the DB)
- Matching engine: deterministic hard filter → weighted soft scoring → AI/templated explanation
- Distinct `mating` match type with breeding-data completeness gating
- Mutual-consent introductions
- Internal messaging (adapter-ready for WhatsApp/SMS later)
- Meetups: availability, proposal, accept/decline, reschedule, cancel
- Reports, blocks, moderation queue, admin console, audit log
- Demo mode with seeded users/dogs/media/conversations and a "simulate other owner" control
- Observability: structured logs, request IDs, health endpoint, job visibility
- Full test suite incl. Playwright E2E over the critical path

### Explicitly out of scope for MVP

Payments, native apps, push notifications, real SMS/WhatsApp delivery, group meetups, calendar
provider sync, breeder/vet verification partnerships, recommendation learning. All are accounted for
in the data model and service boundaries so they can be added without a rewrite (see
`ARCHITECTURE.md` §"Designed-for extensions").

## 7. Key screens

```
┌────────────────────────────────────────────┐
│                🐾 Doggystyle               │
│                                            │
│      What would you like for your dog?     │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ Find my dog an energetic playmate    │  │
│  │ nearby this weekend...               │  │
│  └──────────────────────────────────────┘  │
│                                [ Send → ]  │
│                                            │
│  Find a walking buddy · Find dogs nearby   │
│  Arrange a playdate · Find a mating match  │
└────────────────────────────────────────────┘
```

After sign-in the same composer remains the primary surface; profile cards, match cards, intro
requests and meetup cards render **inline in the conversation** as structured attachments.

## 8. Match result contract

Every candidate returned to the UI carries:

```
photo, name, age, breed, approx_distance_km, score (0-100),
reasons: string[]        // concise, grounded in structured signals
conflicts: string[]      // warnings, e.g. size outside preferred range
intent: playdate|walk|running|social|mating
data_gaps: string[]      // for mating: what is missing before this is a serious candidate
```

## 9. Safety & policy decisions

- **Adults only.** Account holders must be 18+. Rationale and enforcement in `docs/THREAT_MODEL.md`
  §"Age policy" and `PRIVACY.md`. Enforced at signup via attestation + terms acceptance recorded in
  `consent_events`.
- Exact coordinates are stored only when the owner opts in for meetup planning, are never returned
  by list/search endpoints, and are quantised to a ~1 km grid for distance display.
- Blocking is bidirectional and filters matching, messaging and introductions.
- The conversational agent operates under a whitelist of typed actions; untrusted text (imported
  captions, other users' messages) is passed to models inside clearly delimited, non-authoritative
  blocks and can never grant new capabilities.

## 10. Success criteria for the local release

The product owner can, without opening the source code:

1. create an account, 2. enter the conversational product, 3. connect a mock or real media source,
4. have the system identify their dog, 5. get a generated profile, 6. correct it in natural language,
7. ask for matches, 8. receive ranked results, 9. refine conversationally, 10. request an
introduction, 11. complete mutual acceptance, 12. exchange messages, 13. arrange a meetup, and
14. restart the stack with all data intact.
