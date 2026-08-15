<#
.SYNOPSIS
  Stops Doggystyle: the API/web processes and the local PostgreSQL instance.
#>
[CmdletBinding()]
param([switch]$KeepDatabase)

$ErrorActionPreference = 'Continue'
$RepoRoot = $PSScriptRoot

Write-Host ''
foreach ($port in 4000, 5173) {
  $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $connections) {
    $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    # Only ever kill node — never some unrelated process that happens to hold the port.
    if ($proc -and $proc.ProcessName -eq 'node') {
      Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
      Write-Host "  stopped node on port $port (pid $($proc.Id))" -ForegroundColor DarkGray
    } elseif ($proc) {
      Write-Host "  port $port held by '$($proc.ProcessName)' — left alone" -ForegroundColor Yellow
    }
  }
}

if (-not $KeepDatabase) {
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'scripts\pg-local.ps1') stop
} else {
  Write-Host '  database left running' -ForegroundColor DarkGray
}

Write-Host "`n  Doggystyle stopped.`n" -ForegroundColor Green
