# Doggystyle – Deployment & Operations Runbook

> **Status:** Beta  
> **Provider:** [Fly.io](https://fly.io)  
> **Architecture:** Single Fly app (Node 22 + Fastify) serving the React SPA and API on one origin, backed by Fly Postgres (managed) and a persistent Fly volume for uploaded media.

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [First-time deployment](#first-time-deployment)
3. [Secrets reference](#secrets-reference)
4. [Database migrations](#database-migrations)
5. [Redeployment](#redeployment)
6. [Viewing logs](#viewing-logs)
7. [Health check](#health-check)
8. [Backups](#backups)
9. [Rollback](#rollback)
10. [Known limitations](#known-limitations)

---

## Prerequisites

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh   # macOS/Linux
# Or on Windows: irm https://fly.io/install.ps1 | iex

fly auth login   # opens browser
```

---

## First-time deployment

```bash
# 1. Create the Fly app (run once)
fly apps create doggystyle-beta

# 2. Create a persistent volume for uploaded media (1 GB, expandable)
fly volumes create doggystyle_media --size 1 --region cdg

# 3. Provision a Fly Postgres cluster (shared-cpu-1x, 1 GB — free tier)
fly postgres create --name doggystyle-db --region cdg --initial-cluster-size 1

# 4. Attach Postgres — this sets DATABASE_URL automatically as a secret
fly postgres attach doggystyle-db --app doggystyle-beta

# 5. Set required secrets (generate strong values first)
fly secrets set \
  SESSION_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" \
  TOKEN_PEPPER="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")" \
  ADMIN_EMAIL="admin@yourdomainhere.com" \
  ADMIN_PASSWORD="YourStrongAdminPassword!" \
  --app doggystyle-beta

# 6. (Optional) Set the public URL once you know it
fly secrets set PUBLIC_URL="https://doggystyle-beta.fly.dev" --app doggystyle-beta

# 7. Deploy
fly deploy --app doggystyle-beta --remote-only

# The app auto-runs migrations on startup (see apps/api/src/index.ts).
# For the initial seed (demo data), run once:
fly ssh console --app doggystyle-beta -C \
  "node -e \"process.env.SEED_ON_START='true'; require('./apps/api/dist/index.js')\""
# Or set temporarily: fly secrets set SEED_ON_START=true, deploy, then set back to false.
```

---

## Secrets reference

| Variable | Description | Required |
|---|---|---|
| `DATABASE_URL` | Postgres connection URL (set by `fly postgres attach`) | ✅ |
| `SESSION_SECRET` | ≥32-char random string for cookie signing | ✅ |
| `TOKEN_PEPPER` | ≥32-char random string for password hashing | ✅ |
| `ADMIN_EMAIL` | Initial admin account email | ✅ |
| `ADMIN_PASSWORD` | Initial admin account password | ✅ |
| `PUBLIC_URL` | Full HTTPS URL of the deployment | ✅ |
| `ANTHROPIC_API_KEY` | Required only if `AI_PROVIDER=anthropic` | ❌ |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | Only if `MAIL_TRANSPORT=smtp` | ❌ |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Only if Google Photos is enabled | ❌ |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Only if Instagram import is enabled | ❌ |

### Current public Beta overrides

For the live Fly deployment, the following non-default secrets are set:

- `DEMO_MODE=true` so the labeled demo photo source and seeded walkthrough remain available.
- `SEED_ON_START=false` after the initial seed has been completed, so restarts stay lighter.

---

## Database migrations

Migrations run **automatically on every startup** via `drizzle-kit` in `apps/api/src/db/migrate.ts`. No manual step is needed after `fly deploy`.

To run migrations manually (e.g. for debugging):

```bash
fly ssh console --app doggystyle-beta -C \
  "node -e \"require('./apps/api/dist/db/migrate.js').runMigrations().then(r => console.log(r))\""
```

---

## Redeployment

```bash
# From the repository root, on the launch/beta branch:
git push origin launch/beta
fly deploy --app doggystyle-beta --remote-only
```

Fly performs a zero-downtime rolling deploy by default.

---

## Viewing logs

```bash
fly logs --app doggystyle-beta          # live tail
fly logs --app doggystyle-beta -n 200   # last 200 lines
```

The API emits structured JSON logs. Key fields: `level`, `msg`, `requestId`, `userId`, `err`.

---

## Health check

```bash
curl https://doggystyle-beta.fly.dev/api/health
# → {"status":"ok","db":"ok","uptime":…}
```

Fly also polls `/api/health` every 15 s and will not route traffic to an unhealthy instance.

---

## Backups

Fly Postgres performs continuous WAL archiving and takes daily snapshots automatically. To take a manual snapshot:

```bash
fly postgres backup list --app doggystyle-db
fly postgres backup create --app doggystyle-db
```

To restore from a snapshot:

```bash
fly postgres backup restore <snapshot-id> --app doggystyle-db
```

Media files are on a Fly volume (`doggystyle_media`). Fly does **not** replicate volumes across regions by default. For production durability, mirror important uploads to an S3-compatible bucket (Tigris, Cloudflare R2, etc.) — this is a known limitation.

---

## Rollback

```bash
# List recent releases
fly releases --app doggystyle-beta

# Roll back to a previous release
fly deploy --image registry.fly.io/doggystyle-beta:<previous-version> --app doggystyle-beta
```

Alternatively, revert the commit in Git and redeploy:

```bash
git revert HEAD
git push origin launch/beta
fly deploy --app doggystyle-beta --remote-only
```

---

## Known limitations (Beta)

| Limitation | Impact | Plan |
|---|---|---|
| Media stored on a single Fly volume | No cross-region replication; data loss if volume fails | Migrate to object storage (Tigris / R2) |
| Email delivery uses `MAIL_TRANSPORT=store` by default | Emails go to DB, not to user inbox | Configure SMTP credentials |
| Social import (Instagram, Google Photos) disabled | Users must direct-upload | Enable after OAuth credentials are approved |
| Mating/breeding UI disabled in Beta | Hidden from product; API still supports it | Re-enable after safety review |
| Single machine (min_machines_running=1) | No auto-scale under high load | Increase min, add read replica |
| No CDN for media | Media served directly from Fastify | Add Fly's Tigris or Cloudflare |
| Demo admin routes | Accessible if `DEMO_MODE=true` | Keep `DEMO_MODE=false` in production |
