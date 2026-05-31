# cowCode Windows installer
# Download → install → deps → setup → start (pm2)
# Code: %USERPROFILE%\.local\share\cowcode   State: %USERPROFILE%\.cowcode

param(
    [switch]$SkipSetup
)

$ErrorActionPreference = "Stop"

$Branch = if ($env:COWCODE_BRANCH) { $env:COWCODE_BRANCH } else { "master" }
$Tarball = "https://github.com/bishwashere/cowCode/archive/refs/heads/$Branch.tar.gz"
$Extracted = "cowCode-$Branch"

$InstallDir = if ($env:COWCODE_INSTALL_DIR) { $env:COWCODE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".local\share\cowcode" }
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
$Launcher = Join-Path $BinDir "cowcode.cmd"

Write-Host ""
Write-Host "  Welcome to cowCode — WhatsApp bot with your own LLM"
Write-Host "  ------------------------------------------------"
Write-Host ""

# --- sanity checks ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  ✖ Node.js is required but not installed."
    Write-Host "  Download: https://nodejs.org/"
    exit 1
}

# --- temp workspace ---
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("cowcode-install-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
    # --- download ---
    Write-Host "  ► Downloading..."
    $Archive = Join-Path $Work "archive.tar.gz"
    Invoke-WebRequest -Uri $Tarball -OutFile $Archive -UseBasicParsing
    tar -xzf $Archive -C $Work
    Write-Host "  ✓ Done."
    Write-Host ""

    # --- install code ---
    Write-Host "  ► Installing to $InstallDir ..."
    $Src = Join-Path $Work $Extracted
    if (-not (Test-Path $Src)) {
        Write-Host "  ✖ Extracted folder not found: $Src"
        exit 1
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -Path $Src -Force | Where-Object { $_.Name -ne "node_modules" } | ForEach-Object {
        $dest = Join-Path $InstallDir $_.Name
        if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force }
        Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
    }

    Push-Location $InstallDir
    try {
        $installUri = "file:///" + ($InstallDir -replace '\\', '/')
        node --input-type=module -e "import { fetchRemoteBuild, writeBuild } from '$installUri/lib/build-info.js'; const b = await fetchRemoteBuild('$Branch'); if (b) { writeBuild('$($InstallDir -replace '\\', '/')', b); console.log(b); }" 2>$null
        Write-Host "  ✓ Code installed."
    } finally {
        Pop-Location
    }
    Write-Host ""

    # --- launcher ---
    Write-Host "  ► Installing launcher..."
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $cmdContent = @"
@echo off
set COWCODE_INSTALL_DIR=$InstallDir
node "$InstallDir\cli.js" %*
"@
    Set-Content -Path $Launcher -Value $cmdContent -Encoding ASCII
    Write-Host "  ► Launcher installed: $Launcher"

    # --- PATH ---
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$BinDir*") {
        $newPath = if ($userPath) { "$BinDir;$userPath" } else { $BinDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        $env:Path = "$BinDir;$env:Path"
        Write-Host "  ► Added $BinDir to user PATH (open a new terminal if cowcode is not found)"
    }
    Write-Host ""

    # --- dependencies (must run before setup.js) ---
    Write-Host "  ► Installing dependencies..."
    Push-Location $InstallDir
    try {
        $hasDotenv = Test-Path (Join-Path $InstallDir "node_modules\dotenv")
        if ($hasDotenv) {
            Write-Host "  ✓ Dependencies already installed."
        } elseif (Get-Command pnpm -ErrorAction SilentlyContinue) {
            pnpm install
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            Write-Host "  ✓ Dependencies installed."
        } elseif (Get-Command npm -ErrorAction SilentlyContinue) {
            npm install
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            Write-Host "  ✓ Dependencies installed."
        } else {
            Write-Host "  ✖ Neither pnpm nor npm found. Install Node.js properly."
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host ""

    # --- setup ---
    if ($SkipSetup) {
        Write-Host "  ✓ Setup skipped."
    } else {
        Write-Host "  ► Setting up (config + WhatsApp link)..."
        Write-Host "  (When you are done and want to stop the bot, press Ctrl+C.)"
        Write-Host ""
        Push-Location $InstallDir
        try {
            node setup.js
        } catch {
            Write-Host "  Setup exited: $_"
        } finally {
            Pop-Location
        }
    }

    Write-Host ""
    Write-Host "  ------------------------------------------------"

    $env:COWCODE_INSTALL_DIR = $InstallDir
    $env:Path = "$BinDir;$env:Path"

    & node "$InstallDir\cli.js" start
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  ► Bot is running in the background. You can close this window."
        Write-Host "  ► To see logs: cowcode logs"
    } else {
        Write-Host "  ► To start later: cowcode start"
    }
    Write-Host ""
} finally {
    if (Test-Path $Work) {
        Remove-Item -Path $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
