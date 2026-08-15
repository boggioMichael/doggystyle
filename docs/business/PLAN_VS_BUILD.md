# Business plan ⇄ codebase: where they agree, and where the audit is now stale

The Hebrew business plan (`Doggystyle_Full_Business_Plan_HE.docx`, dated 16 Aug 2026)
contains a technical audit performed against **commit `31c7752`**. That commit was an
early snapshot taken while the build was still in progress. This note records what has
changed since, so nobody makes a decision from a stale reading of the repo.

## 1. The audit's technical findings are resolved

| Plan's finding (§2, at `31c7752`) | Status now | Evidence |
| --- | --- | --- |
| "`apps/web` contains only `package.json`; no screens" | ✅ Resolved | Full React 19 + Vite + Tailwind app: landing, auth, chat, profile, intros, messages, meetups, settings, admin |
| "Missing modules: admin, chat, connections, media, meetups, messaging, moderation, social" | ✅ Resolved | All eight implemented under `apps/api/src/modules/` |
| "`worker` and `seed` missing" | ✅ Resolved | Postgres-backed job worker; seed creates 11 users, 10 dogs, 30 photos |
| "No test/spec files found" | ✅ Partly resolved | `scripts/smoke.mjs` (32 end-to-end assertions incl. IDOR/CSRF/privacy) + Playwright E2E. Unit suite still outstanding — see §4 |
| "Typecheck fails" | ✅ Resolved | `tsc --noEmit` clean for both API and web |
| "Integrations shown as working but files absent" | ✅ Resolved | `demo`, `upload`, `archive` work offline; `instagram`, `google_photos` implemented behind credential flags |
| "No demonstrable user journey" | ✅ Resolved | Recorded walkthrough: `docs/media/doggystyle-demo.mp4` |

**The plan's core conclusion still holds**: this is a density-and-trust business, not an
algorithm business, and a public pilot needs far more than a working local build.

## 2. Recommendations the code already implements

| Plan recommendation | How the build satisfies it |
| --- | --- |
| §1 "Do not build on Instagram — Basic Display shut down Dec 2024" | Independently reached the same conclusion. `docs/INTEGRATIONS.md` documents the shutdown and routes personal accounts to the platform's own data export instead |
| §1 "Local infrastructure is for development only" | `ARCHITECTURE.md` and `docs/THREAT_MODEL.md` §7 both state this; TLS/backup/monitoring listed as pre-pilot work |
| §6 "Brand name must be replaced before launch" | Branding is centralised in `packages/shared/src/branding.ts` + `BRAND_NAME` env — a rename is a one-line change, not a refactor |
| §8 "Safety tools stay free; never sell precise location" | Report, block, moderation and deletion have no paywall. Exact coordinates are never serialised to any peer-facing DTO — asserted by an automated check |
| §10 Trust & safety core | Mutual-consent introductions, bidirectional blocking, moderation queue, audit log, 18+ attestation, EXIF stripping, coarse location |
| §7 "One vertical slice as Web/PWA before native apps" | Exactly what was built. PWA manifest + iOS home-screen install; no native app started |

## 3. Where the build deliberately differs — and what you should decide

### Mating / breeding matches
- **Plan says:** out of MVP scope; ethical, legal, veterinary and reputational risk.
- **Build has:** a *separate, explicitly-opted-into* match type that ranks by **data
  completeness**, never by an AI compatibility score, with a standing disclaimer, and a
  database `CHECK` constraint making it impossible for a model to write health, genetic,
  pedigree or reproductive facts.
- **Why:** it was in the original product brief. The implementation follows the plan's
  *reasoning* even though it keeps the feature.
- **Your call:** to follow the plan literally, set the feature flag off — remove
  `'mating'` from `MATCH_INTENTS` in `packages/shared/src/domain.ts` and the intent
  disappears from the parser, the UI and the engine. Nothing else depends on it.

### Product name
The plan flags a competing app with a near-identical name and recommends a rename plus
trademark clearance. **This is a real commercial risk and I cannot clear it for you** — it
needs a trademark search in Israel and your target markets, plus domain and app-store
checks. The code is ready for the rename whenever you decide.

### Revenue
The plan's ladder (events commission → local B2B → consumer premium → marketplace)
matches the seams already in the codebase: a `BillingService` interface, `plan` and
`entitlements` columns on `users`, and n-ary `meetup_participants` for group events. The
BUSL-1.1 licence (`LICENSING.md`) keeps all of those commercially exclusive to you until
2030.

## 4. Honest remaining gaps before any public pilot

These are real, and neither the plan nor this build has closed them:

1. **Unit/integration test suite.** End-to-end coverage exists; per-module unit tests
   (matching weights, intent parsing, redaction) do not. The spend limit cut that agent.
2. **Production environment.** No TLS, no managed backups, no monitoring, no on-call.
   Local-only, as both documents state.
3. **Content moderation is structural, not intelligent.** The hooks and queue exist; no
   classifier is wired in.
4. **Age assurance is self-attested.** Documented as an accepted residual risk.
5. **Real provider credentials.** Instagram and Google Photos need your developer
   accounts (`docs/INTEGRATIONS.md` has the exact steps).

## 5. Reading the plan's numbers

The plan is explicit that its financial figures are **sensitivity scenarios, not
forecasts**, and tags each claim as verified data / management decision / scenario /
needs-verification. Preserve that discipline: the only externally-sourced figure in the
launch thesis is the 20,237 vaccinated dogs in Tel Aviv (2024). Everything about
conversion, pricing and retention is an experiment to run, not a number to present.
