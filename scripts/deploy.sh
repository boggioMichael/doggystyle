#!/usr/bin/env bash
# deploy.sh — run after `flyctl auth login`
# Usage: bash scripts/deploy.sh [app-name] [region]
set -euo pipefail

APP="${1:-doggystyle-beta}"
REGION="${2:-cdg}"
FLY="flyctl"
command -v flyctl &>/dev/null || FLY="$HOME/.fly/bin/flyctl"

echo "=== Doggystyle Beta — Fly.io deploy ==="
echo "App: $APP | Region: $REGION"
echo ""

# 1. Create app (idempotent)
$FLY apps create "$APP" 2>/dev/null || echo "(app already exists)"

# 2. Create media volume (skip if already exists)
if ! $FLY volumes list --app "$APP" | grep -q doggystyle_media; then
  $FLY volumes create doggystyle_media --size 1 --region "$REGION" --app "$APP"
fi

# 3. Create Postgres cluster (skip if already attached)
DB_APP="${APP}-db"
if ! $FLY postgres list 2>/dev/null | grep -q "$DB_APP"; then
  $FLY postgres create \
    --name "$DB_APP" \
    --region "$REGION" \
    --initial-cluster-size 1 \
    --vm-size shared-cpu-1x \
    --volume-size 1
fi

# 4. Attach Postgres (sets DATABASE_URL secret)
$FLY postgres attach "$DB_APP" --app "$APP" 2>/dev/null || echo "(already attached)"

# 5. Set required secrets (generate fresh random values each time if not already set)
SESSION_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
TOKEN_PEPPER=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

echo ""
echo "Setting secrets (SESSION_SECRET, TOKEN_PEPPER, PUBLIC_URL)..."
$FLY secrets set \
  SESSION_SECRET="$SESSION_SECRET" \
  TOKEN_PEPPER="$TOKEN_PEPPER" \
  PUBLIC_URL="https://${APP}.fly.dev" \
  --app "$APP"

echo ""
echo "⚠️  Set ADMIN_EMAIL and ADMIN_PASSWORD manually:"
echo "  flyctl secrets set ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='YourPass' --app $APP"
echo ""

# 6. Deploy
echo "Deploying (remote builder)..."
$FLY deploy --app "$APP" --remote-only

echo ""
echo "✅ Deployed! Open: https://${APP}.fly.dev"
echo "   Health:        https://${APP}.fly.dev/api/health"
echo ""
echo "Run smoke test:"
echo "  node scripts/smoke.mjs https://${APP}.fly.dev"
