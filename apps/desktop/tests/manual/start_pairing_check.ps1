<#
.SYNOPSIS
Starts the manual pairing check of GDT-003 on a physical phone: the test adapter server, Expo
(mobile client in Expo Go) and Godot on the NewGame screen, each in its own window.

.DESCRIPTION
Finds this computer's LAN IPv4 address (an active adapter with a default gateway, not a VPN or
virtual adapter; 192.168.* first, then 10.*, then 172.16-31.*), puts it into the pairing QR
(HS_PUBLIC_HOST) and into the Expo address (REACT_NATIVE_PACKAGER_HOSTNAME). It checks ports,
dependencies and the Windows firewall, but changes no network or firewall settings.
Docs: docs/mobile/qr-mechanics.md, "QR привязки в Godot".

.EXAMPLE
powershell -ExecutionPolicy Bypass -File apps\desktop\tests\manual\start_pairing_check.ps1 -CheckOnly
.EXAMPLE
powershell -ExecutionPolicy Bypass -File apps\desktop\tests\manual\start_pairing_check.ps1 -GodotBin C:\Tools\Godot_v4.7.2-stable_win64.exe
#>
param(
    # LAN address to use instead of the detected one.
    [string]$HostAddress = '',
    [int]$Port = 7420,
    [int]$MetroPort = 8081,
    # Godot 4.7.2 executable; defaults to $env:GODOT_BIN.
    [string]$GodotBin = $env:GODOT_BIN,
    # Run the checks and print the plan without starting anything.
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$desktop = Join-Path $root 'apps\desktop'
$problems = New-Object System.Collections.Generic.List[string]

function Write-Step([string]$text) { Write-Host "== $text" -ForegroundColor Cyan }
function Write-Problem([string]$text) { $problems.Add($text); Write-Host "!! $text" -ForegroundColor Red }

# --- LAN address ---------------------------------------------------------------------------------
Write-Step 'LAN address'
$virtual = 'Wintun|TAP-|TUN|sing-tun|WireGuard|OpenVPN|Tailscale|ZeroTier|Hyper-V|VMware|VirtualBox|Virtual Ethernet|Loopback'
$candidates = @()
foreach ($config in Get-NetIPConfiguration) {
    if (-not $config.IPv4DefaultGateway -or $config.NetAdapter.Status -ne 'Up') { continue }
    if ($config.NetAdapter.InterfaceDescription -match $virtual -or $config.InterfaceAlias -match '^(tun|vEthernet|WSL)') { continue }
    foreach ($ip in $config.IPv4Address) {
        $address = $ip.IPAddress
        if ($address -like '127.*' -or $address -like '169.254.*') { continue }
        $rank = 3
        if ($address -like '192.168.*') { $rank = 0 }
        elseif ($address -like '10.*') { $rank = 1 }
        elseif ($address -match '^172\.(1[6-9]|2[0-9]|3[01])\.') { $rank = 2 }
        $category = (Get-NetConnectionProfile -InterfaceIndex $config.InterfaceIndex -ErrorAction SilentlyContinue).NetworkCategory
        $candidates += [pscustomobject]@{ Address = $address; Interface = $config.InterfaceAlias; Profile = "$category"; Rank = $rank }
    }
}
$candidates = @($candidates | Sort-Object Rank)
foreach ($candidate in $candidates) {
    Write-Host ("   {0,-16} {1} (network profile: {2})" -f $candidate.Address, $candidate.Interface, $candidate.Profile)
}
$chosen = $null
if ($HostAddress) {
    $chosen = [pscustomobject]@{ Address = $HostAddress; Interface = 'given with -HostAddress'; Profile = '' }
} elseif ($candidates.Count -gt 0) {
    $chosen = $candidates[0]
}
if ($null -eq $chosen) {
    Write-Problem 'No LAN address: connect this computer to the same Wi-Fi as the phone, or pass -HostAddress.'
} else {
    Write-Host "   using $($chosen.Address) ($($chosen.Interface))" -ForegroundColor Green
    if ($candidates.Count -gt 1 -and -not $HostAddress) {
        Write-Host '   several networks are active: if the phone is on another one, pass -HostAddress <its LAN address>'
    }
}

# --- Ports, dependencies -------------------------------------------------------------------------
Write-Step 'Ports and dependencies'
foreach ($busy in @($Port, $MetroPort)) {
    $listener = Get-NetTCPConnection -LocalPort $busy -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $owner = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Write-Problem "Port $busy is taken by $owner (PID $($listener.OwningProcess)): close it first."
    } else {
        Write-Host "   port $busy free"
    }
}
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Problem 'Node.js is not on PATH.' } else { Write-Host "   node $(& node --version) at $($node.Source)" }
foreach ($required in @('node_modules\tsx\dist\loader.mjs', 'node_modules\expo\package.json')) {
    if (-not (Test-Path (Join-Path $root $required))) { Write-Problem "Missing ${required}: run npm ci in $root." }
}
if (-not $GodotBin) {
    Write-Problem 'Godot is not set: pass -GodotBin <Godot_v4.7.2 exe> or set $env:GODOT_BIN.'
} elseif (-not (Test-Path $GodotBin)) {
    Write-Problem "Godot not found at $GodotBin."
} else {
    Write-Host "   godot $GodotBin"
}

# --- Firewall (read only) ------------------------------------------------------------------------
Write-Step 'Windows firewall (read only, nothing is changed)'
if ($node -and $chosen -and $chosen.Profile) {
    $nodeRules = Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
        Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -eq $node.Source }
    $covered = $nodeRules | Where-Object { $_.Profile -eq 'Any' -or "$($_.Profile)" -match $chosen.Profile }
    if ($covered) {
        Write-Host "   inbound Node.js is allowed on the $($chosen.Profile) profile"
    } else {
        Write-Host "   no inbound rule for Node.js on the $($chosen.Profile) profile: when Windows asks, allow Node.js for this network" -ForegroundColor Yellow
    }
} else {
    Write-Host '   network profile unknown: if Windows asks about Node.js, allow it for this (private) network'
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host 'Not started: fix the problems above and run the script again.' -ForegroundColor Red
    exit 1
}
$lan = $chosen.Address
if ($CheckOnly) {
    Write-Host ''
    Write-Host "Checks passed. Without -CheckOnly the script starts the server on ${lan}:$Port, Expo on exp://${lan}:$MetroPort and Godot." -ForegroundColor Green
    exit 0
}

# --- Start ---------------------------------------------------------------------------------------
Write-Step 'Starting'
$serverCommand = "`$host.UI.RawUI.WindowTitle = 'GDT-003 server'; Set-Location '$root'; `$env:HS_PUBLIC_HOST = '$lan'; node --import tsx apps/desktop/tests/live/pairing_server.mjs --mode=adapter --manual --port=$Port"
Start-Process powershell -WorkingDirectory $root -ArgumentList @('-NoExit', '-NoProfile', '-Command', $serverCommand) | Out-Null
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    try {
        $ready = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://${lan}:$Port/api/v1/health").StatusCode -eq 200
    } catch { $ready = $false }
}
if (-not $ready) {
    Write-Host "The server did not answer at http://${lan}:$Port/api/v1/health within 90 s; see the 'GDT-003 server' window." -ForegroundColor Red
    exit 1
}
Write-Host "   server answers at http://${lan}:$Port" -ForegroundColor Green

$expoCommand = "`$host.UI.RawUI.WindowTitle = 'GDT-003 Expo'; Set-Location '$root'; `$env:REACT_NATIVE_PACKAGER_HOSTNAME = '$lan'; npm run start -w @hs/mobile -- --port $MetroPort"
Start-Process powershell -WorkingDirectory $root -ArgumentList @('-NoExit', '-NoProfile', '-Command', $expoCommand) | Out-Null

if (-not (Test-Path (Join-Path $desktop '.godot'))) {
    Write-Host '   importing the Godot project (first run)...'
    & $GodotBin --headless --path $desktop --import | Out-Null
}
Start-Process $GodotBin -WorkingDirectory $desktop -ArgumentList @('--path', $desktop, '--maximized', '--', "--server=http://127.0.0.1:$Port") | Out-Null

Write-Host ''
Write-Host 'Started: windows "GDT-003 server", "GDT-003 Expo" and Godot (NewGame).' -ForegroundColor Green
Write-Host "1. iPhone Safari: http://${lan}:$Port/api/v1/health must show status ok (same Wi-Fi)."
Write-Host '2. iPhone Camera: scan the QR in the "GDT-003 Expo" window, open it in Expo Go.'
Write-Host '3. Godot: scenario Sanatorium, turn off random seed, seed winter-42, create the case.'
Write-Host '4. App: pair the phone, allow the camera, scan the Godot QR from 50 cm.'
Write-Host '5. Expected: "POST /pair -> 200" in the "GDT-003 server" window. Close the three windows when done.'
