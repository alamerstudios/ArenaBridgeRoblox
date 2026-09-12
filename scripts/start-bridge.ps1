<#
.SYNOPSIS
    NexusAI Bridge - PowerShell Launcher.

.DESCRIPTION
    Startet die Node.js Bridge, liest die dynamisch erzeugte URL und den
    dynamisch erzeugten Token aus der ---BRIDGE--- Box und zeigt beides
    hervorgehoben an. Der Token aendert sich bei jedem Start; er wird niemals
    im Code hinterlegt.

    Zusaetzlich werden url + token in $env:NEXUSAI_BRIDGE_URL /
    $env:NEXUSAI_BRIDGE_TOKEN gesetzt und - falls moeglich - der Token in die
    Zwischenablage kopiert.

.PARAMETER Port
    Port fuer die Bridge. 0 (Standard) = freier Port wird automatisch gewaehlt.

.PARAMETER LogLevel
    debug | info | warn | error | silent

.PARAMETER Open
    Oeffnet das Dashboard automatisch im Standardbrowser.

.PARAMETER NoDashboard
    Deaktiviert das Web-Dashboard.

.EXAMPLE
    .\scripts\start-bridge.ps1
.EXAMPLE
    .\scripts\start-bridge.ps1 -Port 8787 -LogLevel debug -Open
#>

[CmdletBinding()]
param(
    [int]$Port = 0,
    [ValidateSet('debug', 'info', 'warn', 'error', 'silent')]
    [string]$LogLevel = 'info',
    [switch]$Open,
    [switch]$NoDashboard,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Extra
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$Line = '=' * 60

function Write-Banner {
    param([string]$Url, [string]$Token)

    Write-Host ''
    Write-Host $Line -ForegroundColor DarkCyan
    Write-Host 'NexusAI Bridge: LAEUFT' -ForegroundColor Green
    Write-Host $Line -ForegroundColor DarkCyan
    Write-Host '---BRIDGE---' -ForegroundColor DarkGray
    Write-Host 'url: '   -NoNewline -ForegroundColor Gray; Write-Host $Url   -ForegroundColor Cyan
    Write-Host 'token: ' -NoNewline -ForegroundColor Gray; Write-Host $Token -ForegroundColor Yellow
    Write-Host '---END---' -ForegroundColor DarkGray
    Write-Host ''
}

# --- Node pruefen ----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host '[FEHLER] Node.js nicht gefunden. Bitte Node.js 18+ installieren: https://nodejs.org' -ForegroundColor Red
    exit 1
}

$nodeVersion = (& node --version).TrimStart('v')
$major = [int]($nodeVersion -split '\.')[0]
if ($major -lt 18) {
    Write-Host "[FEHLER] Node.js $nodeVersion ist zu alt. Mindestens Version 18 wird benoetigt." -ForegroundColor Red
    exit 1
}

# --- Argumente zusammenbauen ----------------------------------------------
$argsList = @('src/index.js', '--port', $Port, '--log-level', $LogLevel)
if ($NoDashboard) { $argsList += '--no-dashboard' }
if ($Extra)       { $argsList += $Extra }

Write-Host ''
Write-Host "NexusAI Bridge wird gestartet (Node $nodeVersion)..." -ForegroundColor DarkGray
Write-Host 'Der Token wird jetzt neu generiert - er gilt nur fuer diese Sitzung.' -ForegroundColor DarkGray

# --- Bridge starten und Ausgabe streamen -----------------------------------
$bridgeUrl    = $null
$bridgeToken  = $null
$inBridgeBlock = $false
$bannerShown  = $false

try {
    & node @argsList 2>&1 | ForEach-Object {
        $line = [string]$_

        if ($line -match '^---BRIDGE---') { $inBridgeBlock = $true; return }
        if ($inBridgeBlock) {
            if ($line -match '^url:\s*(.+)$')   { $bridgeUrl   = $Matches[1].Trim(); return }
            if ($line -match '^token:\s*(.+)$') { $bridgeToken = $Matches[1].Trim(); return }
            if ($line -match '^---END---') {
                $inBridgeBlock = $false

                Write-Banner -Url $bridgeUrl -Token $bridgeToken
                $bannerShown = $true

                # Fuer weitere Tools in dieser Sitzung verfuegbar machen.
                $env:NEXUSAI_BRIDGE_URL   = $bridgeUrl
                $env:NEXUSAI_BRIDGE_TOKEN = $bridgeToken

                try {
                    Set-Clipboard -Value $bridgeToken -ErrorAction Stop
                    Write-Host 'Token wurde in die Zwischenablage kopiert.' -ForegroundColor DarkGreen
                } catch {
                    Write-Host 'Hinweis: Token konnte nicht in die Zwischenablage kopiert werden.' -ForegroundColor DarkGray
                }

                if ($Open -and -not $NoDashboard) {
                    $dash = "$bridgeUrl/dashboard?token=$([uri]::EscapeDataString($bridgeToken))"
                    Start-Process $dash | Out-Null
                    Write-Host "Dashboard geoeffnet: $bridgeUrl/dashboard" -ForegroundColor DarkGreen
                }

                Write-Host ''
                Write-Host 'Naechste Schritte:' -ForegroundColor White
                Write-Host '  1. Roblox Studio oeffnen und das NexusAI-Plugin starten (roblox/NexusAIPlugin.server.lua)' -ForegroundColor Gray
                Write-Host '  2. Im Plugin-Fenster url + token aus der Box oben eintragen' -ForegroundColor Gray
                Write-Host '  3. Status pruefen:' -ForegroundColor Gray
                Write-Host "     Invoke-RestMethod -Uri '$bridgeUrl/status' -Headers @{ Authorization = 'Bearer ' + `$env:NEXUSAI_BRIDGE_TOKEN }" -ForegroundColor DarkGray
                Write-Host ''
                Write-Host 'Beenden mit Strg+C.' -ForegroundColor DarkGray
                Write-Host $Line -ForegroundColor DarkCyan
                Write-Host ''
                return
            }
            return
        }

        # Restliche Bridge-Ausgabe (Logs) einfach durchreichen.
        if ($line -match '\bERROR\b')     { Write-Host $line -ForegroundColor Red }
        elseif ($line -match '\bWARN\b')  { Write-Host $line -ForegroundColor Yellow }
        elseif ($bannerShown)             { Write-Host $line -ForegroundColor Gray }
        else                              { Write-Host $line -ForegroundColor DarkGray }
    }
}
catch {
    Write-Host "[FEHLER] Bridge konnte nicht gestartet werden: $_" -ForegroundColor Red
    exit 1
}
finally {
    $env:NEXUSAI_BRIDGE_TOKEN = $null
}

Write-Host ''
Write-Host 'NexusAI Bridge wurde beendet.' -ForegroundColor DarkGray
exit $LASTEXITCODE
