# ADR 0002 — PostgreSQL + Drizzle ORM, no PostGIS, no vector DB

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The domain is highly relational (users → dogs → profiles → attributes → matches → connections →
conversations → meetups). We also need geo distance filtering and, eventually, semantic similarity.

## Decision

- **PostgreSQL 16** as the single source of truth.
- **Drizzle ORM** with SQL migration files checked into `apps/api/drizzle/`.
- Geo: store coarse `lat/lng` doubles + `geohash5`; filter with a bounding box then exact haversine
  in SQL. Enable `cube`/`earthdistance` for index-assisted radius queries. **No PostGIS.**
- Semantic search: an optional `pgvector` column, off by default. **No dedicated vector database.**

## Rationale

- PostGIS is a large operational dependency for what is currently a "dogs within N km" query.
- A vector DB would duplicate the source of truth; business-critical data stays relational.
- Drizzle emits plain SQL migrations (auditable, reviewable) and has no native query engine binary,
  which matters on Windows.

## Consequences

- If geo query volume becomes the bottleneck, swap the one SQL builder in
  `modules/matching/geoFilter.ts` for PostGIS or H3 — no callers change.
- Drizzle's ecosystem is smaller than Prisma's; mitigated by keeping repository code plain.
