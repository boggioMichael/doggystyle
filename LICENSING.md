# Licensing & commercial use

> This document explains the licensing model in plain language. It is a summary,
> not legal advice, and the [`LICENSE`](LICENSE) file is what actually governs.
> Have a lawyer review before you sell anything under it.

## The short version

Doggystyle is **source-available**, not open source, under the
**Business Source License 1.1 (BUSL-1.1)** — the same model used by MariaDB,
Sentry, CockroachDB and HashiCorp.

| You want to… | Allowed under BUSL-1.1? |
| --- | --- |
| Read, fork, modify, learn from the code | ✅ Yes |
| Run it for yourself and your own dog | ✅ Yes |
| Use it internally to evaluate or test | ✅ Yes |
| Use it in research, teaching, a thesis | ✅ Yes |
| Do security research and publish findings | ✅ Yes |
| Contribute improvements back | ✅ Yes |
| **Launch a competing dog-matching product with it** | ❌ Needs a commercial licence |
| **Offer it as a hosted service to other people** | ❌ Needs a commercial licence |

On the **Change Date (2030-08-16)**, each released version automatically
converts to the **Apache License 2.0** — fully permissive, forever. So the code
is never locked away permanently; the restriction is time-boxed to protect the
commercial runway of the product's early years.

## Why this licence

The goal is to keep the project public and inspectable — good for trust,
contributions, hiring and security review — while preventing someone from
taking the whole product and launching it as a competing service before the
project has a chance to become a business.

Alternatives that were considered and rejected:

| Option | Why not |
| --- | --- |
| MIT / Apache-2.0 | Anyone could relaunch this commercially on day one |
| AGPL-3.0 | Copyleft deters some contributors and does not stop a SaaS competitor who publishes their changes |
| Fully proprietary | Loses the trust and contribution benefits of a public repo |
| Elastic License 2.0 | Similar effect, but never converts to open source |

## Commercial licensing

If you want to use Doggystyle in a way BUSL-1.1 does not permit — a commercial
product, a hosted service, a white-label deployment, or an OEM integration — a
separate commercial licence is available.

**Contact:** boggio.michael@gmail.com

Typical arrangements:

- **Startup / single product** — per-product licence, flat annual fee.
- **Hosted / SaaS** — revenue-share or per-seat.
- **Enterprise / white-label** — negotiated, includes support terms.
- **OEM / embedded** — negotiated per unit or per deployment.

## Monetisation paths this licence keeps open

The application itself is already structured so paid features can be layered in
without a rewrite (see `ARCHITECTURE.md` §11 and the `BillingService` seam):

- free basic matching, paid premium search filters
- profile and breeder verification as a paid tier
- boosted visibility in match results
- event and group-meetup memberships
- a marketplace for professional dog services (trainers, walkers, groomers)
- subscriptions and regional licensing

Because the repo is BUSL rather than permissive, all of these remain
commercially exclusive to the Licensor until the Change Date.

## Contributions

Contributions are welcome. By opening a pull request you agree that your
contribution is licensed under the same terms as the project, and you grant the
Licensor the right to relicense your contribution as part of a commercial
licence. If a formal CLA becomes necessary, it will be added before any
outside contributions are merged.

## Third-party dependencies

Doggystyle's own source is BUSL-1.1. Its dependencies keep their own licences
(largely MIT / Apache-2.0 / BSD) and are not relicensed by this project. Run
`npm ls --all` or a licence scanner before distributing a build if you need a
full attribution list.
