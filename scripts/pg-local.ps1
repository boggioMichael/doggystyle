<#
.SYNOPSIS
  Manages a self-contained PostgreSQL 16 instance for Doggystyle on Windows —
  no installer, no administrator rights, no Docker.

.DESCRIPTION
  Downloads the official EnterpriseDB PostgreSQL binaries ZIP into .tools/,
  initialises a cluster in .tools/pgdata, and starts it on POSTGRES_PORT.

  Windows note: the EDB binaries need the Microsoft Visual C++ runtime. Rather
  than requiring an admin-only redistributable install, we copy the DLLs
  side-by-side into the postgres bin/ directory from a runtime already present
  on the machine (app-local deployment, which Microsoft supports).

.PARAMETER Action
  init | start | stop | status | psql | destroy

.EXAMPLE
  .\scripts\pg-local.ps1 start
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status', 'psql', 'destroy')]
  [string]$Action = 'start',
  [string]$SqlCommand = ''
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $RepoRoot '.tools'
$PgDir    = Join-Path $ToolsDir 'pgsql'
$BinDir   = Join-Path $PgDir 'bin'
$DataDir  = Join-Path $ToolsDir 'pgdata'
$LogFile  = Join-Path $ToolsDir 'postgres.log'
$PgVersion = '16.10-1'

function Read-DotEnv {
  $envFile = Join-Path $RepoRoot '.env'
  $map = @{}
  if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile)) {
      $t = $line.Trim()
      if (-not $t -or $t.StartsWith('#')) { continue }
      $i = $t.IndexOf('=')
      if ($i -lt 1) { continue }
      $k = $t.Substring(0, $i).Trim()
      $v = $t.Substring($i + 1).Trim().Trim('"').Trim("'")
      $map[$k] = $v
    }
  }
  return $map
}

$DotEnv = Read-DotEnv
$PgPort = if ($DotEnv['POSTGRES_PORT']) { $DotEnv['POSTGRES_PORT'] } else { '5433' }
$PgUser = if ($DotEnv['POSTGRES_USER']) { $DotEnv['POSTGRES_USER'] } else { 'doggystyle' }
$PgPass = $DotEnv['POSTGRES_PASSWORD']
$PgDb   = if ($DotEnv['POSTGRES_DB']) { $DotEnv['POSTGRES_DB'] } else { 'doggystyle' }

function Install-VcRuntime {
  # PostgreSQL's Windows build links against the MSVC runtime. Copy it next to
  # the binaries instead of requiring an admin-level redistributable install.
  $needed = @('vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll')
  $missing = $needed | Where-Object { -not (Test-Path (Join-Path $BinDir $_)) -and -not (Test-Path "C:\Windows\System32\$_") }
  if ($missing.Count -eq 0) { return }

  $searchRoots = @(
    "$env:LOCALAPPDATA\Programs\Python",
    "C:\Program Files (x86)\Microsoft\Edge\Application",
    "C:\Program Files (x86)\Microsoft\EdgeCore",
    "$env:LOCALAPPDATA\Programs\Microsoft VS Code",
    "C:\Program Files\nodejs"
  )
  foreach ($dll in $needed) {
    if (Test-Path (Join-Path $BinDir $dll)) { continue }
    $src = $null
    foreach ($root in $searchRoots) {
      if (-not (Test-Path $root)) { continue }
      $hit = Get-ChildItem -Path $root -Recurse -File -Filter $dll -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if ($hit) { $src = $hit.FullName; break }
    }
    if ($src) {
      Copy-Item $src (Join-Path $BinDir $dll) -Force
      Write-Host "  + runtime: $dll" -ForegroundColor DarkGray
    } elseif (-not (Test-Path "C:\Windows\System32\$dll")) {
      throw @"
Missing $dll and no copy found on this machine.

Install the Microsoft Visual C++ Redistributable (x64), then re-run:
  https://aka.ms/vs/17/release/vc_redist.x64.exe
"@
    }
  }
}

function Ensure-Binaries {
  if (Test-Path (Join-Path $BinDir 'initdb.exe')) { Install-VcRuntime; return }

  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  $zip = Join-Path $ToolsDir 'pg.zip'
  if (-not (Test-Path $zip)) {
    $url = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip"
    Write-Host "Downloading PostgreSQL $PgVersion binaries (~320 MB, one time)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 1800
  }
  Write-Host 'Extracting PostgreSQL...' -ForegroundColor Cyan
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $ToolsDir)
  Install-VcRuntime
}

function Test-Running {
  if (-not (Test-Path (Join-Path $DataDir 'postmaster.pid'))) { return $false }
  & (Join-Path $BinDir 'pg_ctl.exe') -D $DataDir status *> $null
  return ($LASTEXITCODE -eq 0)
}

function Invoke-Init {
  Ensure-Binaries
  if (Test-Path (Join-Path $DataDir 'PG_VERSION')) {
    Write-Host 'Cluster already initialised.' -ForegroundColor DarkGray
    return
  }
  if (-not $PgPass) { throw 'POSTGRES_PASSWORD is not set in .env — run start.ps1, which generates it.' }

  Write-Host "Initialising cluster in $DataDir ..." -ForegroundColor Cyan
  $pwFile = Join-Path $ToolsDir 'pw.tmp'
  try {
    Set-Content -Path $pwFile -Value $PgPass -Encoding ascii -NoNewline
    & (Join-Path $BinDir 'initdb.exe') -D $DataDir -U $PgUser --pwfile=$pwFile `
        --encoding=UTF8 --locale=C --auth-local=scram-sha-256 --auth-host=scram-sha-256 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "initdb failed with exit code $LASTEXITCODE" }
  } finally {
    if (Test-Path $pwFile) { Remove-Item $pwFile -Force }
  }

  # Bind to loopback only. This database must never be reachable from the network.
  Add-Content -Path (Join-Path $DataDir 'postgresql.conf') -Value @"

# ── Doggystyle local defaults ───────────────────────────────────────────────
listen_addresses = 'localhost'
port = $PgPort
max_connections = 60
shared_buffers = 256MB
log_min_duration_statement = 500
timezone = 'UTC'
"@
}

function Invoke-Start {
  Invoke-Init
  if (Test-Running) { Write-Host "PostgreSQL already running on port $PgPort." -ForegroundColor DarkGray; return }

  Write-Host "Starting PostgreSQL on port $PgPort ..." -ForegroundColor Cyan
  & (Join-Path $BinDir 'pg_ctl.exe') -D $DataDir -l $LogFile -o "-p $PgPort" -w -t 60 start | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '--- postgres.log (tail) ---' -ForegroundColor Red
    if (Test-Path $LogFile) { Get-Content $LogFile -Tail 25 }
    throw "PostgreSQL failed to start (exit $LASTEXITCODE)."
  }

  # Create the application database if it does not exist yet.
  # Use 127.0.0.1 explicitly: "localhost" can resolve to ::1 first and stall.
  $env:PGPASSWORD = $PgPass
  $exists = & (Join-Path $BinDir 'psql.exe') -h 127.0.0.1 -p $PgPort -U $PgUser -d postgres -tAc `
              "select 1 from pg_database where datname='$PgDb'"
  if (-not $exists) {
    & (Join-Path $BinDir 'createdb.exe') -h 127.0.0.1 -p $PgPort -U $PgUser $PgDb
    Write-Host "  + created database '$PgDb'" -ForegroundColor DarkGray
  }
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Write-Host "PostgreSQL ready on 127.0.0.1:$PgPort" -ForegroundColor Green
}

function Invoke-Stop {
  if (-not (Test-Path (Join-Path $DataDir 'postmaster.pid'))) { Write-Host 'Not running.'; return }
  & (Join-Path $BinDir 'pg_ctl.exe') -D $DataDir -m fast -w stop | Out-Null
  Write-Host 'PostgreSQL stopped.' -ForegroundColor Green
}

function Invoke-Status {
  if (Test-Running) { Write-Host "running on port $PgPort" -ForegroundColor Green }
  else { Write-Host 'stopped' -ForegroundColor Yellow; exit 1 }
}

function Invoke-Psql {
  $env:PGPASSWORD = $PgPass
  try {
    if ($SqlCommand) {
      & (Join-Path $BinDir 'psql.exe') -h 127.0.0.1 -p $PgPort -U $PgUser -d $PgDb -c $SqlCommand
    } else {
      & (Join-Path $BinDir 'psql.exe') -h 127.0.0.1 -p $PgPort -U $PgUser -d $PgDb
    }
  } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}

function Invoke-Destroy {
  Invoke-Stop
  if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force }
  Write-Host 'Cluster destroyed.' -ForegroundColor Yellow
}

switch ($Action) {
  'init'    { Invoke-Init }
  'start'   { Invoke-Start }
  'stop'    { Invoke-Stop }
  'status'  { Invoke-Status }
  'psql'    { Invoke-Psql }
  'destroy' { Invoke-Destroy }
}
