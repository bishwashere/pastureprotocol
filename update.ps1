# cowCode Windows update — same flow as update.sh (no bash required)
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$Branch = if ($env:COWCODE_BRANCH) { $env:COWCODE_BRANCH } else { "master" }
$Tarball = "https://github.com/bishwashere/cowCode/archive/refs/heads/$Branch.tar.gz"
$Extracted = "cowCode-$Branch"

$Root = if ($env:COWCODE_ROOT) { $env:COWCODE_ROOT } elseif ($env:COWCODE_INSTALL_DIR) { $env:COWCODE_INSTALL_DIR } else { $PSScriptRoot }
$StateDir = if ($env:COWCODE_STATE_DIR) { $env:COWCODE_STATE_DIR } else { Join-Path $env:USERPROFILE ".cowcode" }

if (-not (Test-Path (Join-Path $Root "package.json")) -or -not (Test-Path (Join-Path $Root "index.js"))) {
    Write-Host ""
    Write-Host "  Run from inside your cowCode folder, or use:  cowcode update"
    Write-Host ""
    exit 1
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("cowcode-update-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
    if (-not $Force) {
        $localVer = node -p "require('$Root/package.json').version" 2>$null
        $remoteJson = Join-Path $Work "remote_package.json"
        $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/bishwashere/cowCode/$Branch/package.json?t=$ts" -OutFile $remoteJson -UseBasicParsing
        $remoteVer = node -p "require('$remoteJson').version" 2>$null
        if ($localVer -and $remoteVer -and ($localVer -eq $remoteVer)) {
            Write-Host ""
            Write-Host "  Already up to date (v$localVer)."
            Write-Host ""
            exit 0
        }
    }

    Write-Host ""
    Write-Host "  cowCode — Updating..."
    Write-Host "  ------------------------------------------------"
    Write-Host ""

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

    Write-Host "  ► Downloading latest..."
    $Archive = Join-Path $Work "archive.tar.gz"
    Invoke-WebRequest -Uri $Tarball -OutFile $Archive -UseBasicParsing
    tar -xzf $Archive -C $Work
    $Src = Join-Path $Work $Extracted

    Write-Host "  ► Updating files..."
    Get-ChildItem -Path $Src -Force | Where-Object { $_.Name -ne "node_modules" } | ForEach-Object {
        $dest = Join-Path $Root $_.Name
        if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force }
        Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
    }

    Write-Host "  ► Installing dependencies..."
    Push-Location $Root
    try {
        if (Test-Path "node_modules") { Remove-Item -Path "node_modules" -Recurse -Force }
        if (Get-Command pnpm -ErrorAction SilentlyContinue) {
            pnpm install --silent 2>$null
            if ($LASTEXITCODE -ne 0) { npm install --silent 2>$null }
        } else {
            npm install --silent 2>$null
        }
    } finally {
        Pop-Location
    }

    $buildOut = node --input-type=module -e @"
import { fetchRemoteBuild, writeBuild } from 'file:///$($Root -replace '\\','/')/lib/build-info.js';
const b = await fetchRemoteBuild('$Branch');
if (b) writeBuild('$($Root -replace '\\','/')', b);
"@ 2>$null

    $nowVer = node -p "require('$Root/package.json').version" 2>$null
    Write-Host ""
    if ($nowVer) {
        Write-Host "  ✓ Update complete. Now at v$nowVer"
    } else {
        Write-Host "  ✓ Update complete."
    }
    Write-Host "  Start the bot:  cowcode start"
    Write-Host "  If already running, restart:  cowcode restart"
    Write-Host ""
} finally {
    if (Test-Path $Work) {
        Remove-Item -Path $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
