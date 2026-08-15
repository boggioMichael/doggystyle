<#
.SYNOPSIS
  One-time setup so phones on your Wi-Fi (e.g. an iPhone) can reach the
  Doggystyle server running on this computer.

.DESCRIPTION
  Adds an inbound Windows Firewall rule for TCP port 4000 (Private network
  profile only — never Public). Creating firewall rules requires
  administrator rights, so this script re-launches itself elevated; accept
  the UAC prompt when it appears.

  After it succeeds, open  http://<this computer's IP>:4000  on your phone
  (the start script prints the exact address), then use Share → Add to Home
  Screen to install Doggystyle as an app.
#>
[CmdletBinding()]
param([switch]$Elevated)

$ErrorActionPreference = 'Stop'
$RuleName = 'Doggystyle local server (TCP 4000)'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  if ($Elevated) { Write-Error 'Elevation failed.'; exit 1 }
  Write-Host 'Requesting administrator rights (accept the UAC prompt)...' -ForegroundColor Cyan
  Start-Process powershell -Verb RunAs -Wait -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated'
  )
  # Report the outcome from the unelevated side.
  if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
    Write-Host 'Firewall rule is in place.' -ForegroundColor Green
  } else {
    Write-Host 'Firewall rule was not created (UAC declined?). Phones will not reach the server until it exists.' -ForegroundColor Yellow
    exit 1
  }
  exit 0
}

if (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue) {
  Write-Host 'Firewall rule already exists — nothing to do.' -ForegroundColor Green
} else {
  New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort 4000 -Profile Private | Out-Null
  Write-Host 'Firewall rule created: inbound TCP 4000, Private networks only.' -ForegroundColor Green
}

$ips = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } |
  Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host 'On your phone (same Wi-Fi), open:' -ForegroundColor Cyan
foreach ($ip in $ips) { Write-Host "  http://${ip}:4000" -ForegroundColor White }
Write-Host 'Then: Share button -> Add to Home Screen.' -ForegroundColor Cyan
