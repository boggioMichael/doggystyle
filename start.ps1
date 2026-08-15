<#
.SYNOPSIS
  Starts the whole Doggystyle stack on this computer.

.DESCRIPTION
  One command, no Docker required. It will:
    1. check prerequisites and create .env with fresh secrets on first run
    2. install dependencies if needed
    3. start a self-contained PostgreSQL (downloaded once into .tools/)
    4. run database migrations and seed the demo data
    5. build the web app and serve everything from a single origin

.PARAMETER Dev
  Run in development mode: Vite dev server on :5173 with hot reload,
  API on :4000. Otherwise the API serves the built app on :4000.

.PARAMETER SkipBuild
  Reuse an existing web build instead of rebuilding.

.PARAMETER Fresh
  Drop the database and re-seed from scratch.

.EXAMPLE
  .\start.ps1
.EXAMPLE
  .\start.ps1 -Dev
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$SkipBuild,
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot
Set-Location $RepoRoot

function Step($msg) { Write-Host "`n▸ $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  $msg" -ForegroundColor DarkGray }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  🐾  Doggystyle" -ForegroundColor White
Write-Host "  Tell us what you want for your dog. We do the rest." -ForegroundColor DarkGray

# ── 1. Preflight ────────────────────────────────────────────────────────────
Step 'Checking prerequisites'
node scripts/preflight.mjs
if ($LASTEXITCODE -ne 0) { throw 'Preflight checks failed — see the messages above.' }

# ── 2. Dependencies ─────────────────────────────────────────────────────────
if (-not (Test-Path 'node_modules')) {
  Step 'Installing dependencies (first run only, a few minutes)'
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
} else {
  Ok 'Dependencies present'
}

# ── 3. Database ─────────────────────────────────────────────────────────────
Step 'Starting PostgreSQL'
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\pg-local.ps1') start
if ($LASTEXITCODE -ne 0) { throw 'Could not start PostgreSQL.' }

# ── 4. Shared package ───────────────────────────────────────────────────────
Step 'Building shared types'
npm run build --workspace @doggystyle/shared | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to build @doggystyle/shared.' }

# ── 5. Migrations + seed ────────────────────────────────────────────────────
if ($Fresh) {
  Step 'Resetting the database (dropping all data)'
  npm run db:reset --workspace @doggystyle/api
} else {
  Step 'Applying database migrations'
  npm run db:migrate --workspace @doggystyle/api
  if ($LASTEXITCODE -ne 0) { throw 'Migrations failed.' }
  Step 'Seeding demo data (skipped if already present)'
  npm run db:seed --workspace @doggystyle/api
}

# ── 6. Run ──────────────────────────────────────────────────────────────────
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
  Select-Object -ExpandProperty IPAddress

if ($Dev) {
  Step 'Starting in development mode'
  Write-Host ''
  Write-Host '  Web (hot reload):  http://localhost:5173' -ForegroundColor Green
  Write-Host '  API:               http://localhost:4000' -ForegroundColor Green
  Write-Host ''
  $env:SERVE_WEB = 'false'
  npm run dev
} else {
  if (-not $SkipBuild -or -not (Test-Path 'apps\web\dist\index.html')) {
    Step 'Building the web app'
    npm run build --workspace @doggystyle/web | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
  } else {
    Ok 'Reusing existing web build'
  }

  Step 'Building the API'
  npm run build --workspace @doggystyle/api | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'API build failed.' }

  Write-Host ''
  Write-Host '  ────────────────────────────────────────────────' -ForegroundColor DarkGray
  Write-Host '   Doggystyle is running' -ForegroundColor Green
  Write-Host ''
  Write-Host '   On this computer:  http://localhost:4000' -ForegroundColor White
  foreach ($ip in $ips) {
    Write-Host "   On your phone:     http://${ip}:4000" -ForegroundColor White
  }
  Write-Host ''
  Write-Host '   Demo sign-in:      owner1@demo.doggystyle.local / Demo123!' -ForegroundColor DarkGray
  Write-Host '   Admin sign-in:     admin@doggystyle.local / DemoAdmin!2026' -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '   Phone not connecting? Run: .\scripts\allow-lan.ps1' -ForegroundColor DarkGray
  Write-Host '   Stop everything with:      .\stop.ps1' -ForegroundColor DarkGray
  Write-Host '  ────────────────────────────────────────────────' -ForegroundColor DarkGray
  Write-Host ''

  $env:SERVE_WEB = 'true'
  $env:HOST = '0.0.0.0'
  $env:SEED_ON_START = 'false'
  npm run start --workspace @doggystyle/api
}
