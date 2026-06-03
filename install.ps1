# cowCode Windows installer
# Download -> install -> deps -> setup -> start (pm2)
# Code: %USERPROFILE%\.local\share\cowcode   State: %USERPROFILE%\.cowcode
# Install: iwr -useb https://raw.githubusercontent.com/bishwashere/cowcode/master/install.ps1 | iex

param(
    [switch]$SkipSetup
)

# Windows PowerShell 5.1: "Stop" treats native stderr (npm/tar/node) as fatal and closes the window.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Exit-Install {
    param([int]$Code = 0)
    if ($Code -ne 0) {
        Write-Host ""
        Write-Host "  [X] Install failed (exit $Code). See messages above."
        if ($Host.Name -eq "ConsoleHost") {
            try { Read-Host "Press Enter to close" } catch { }
        }
    }
    exit $Code
}

function Invoke-Native {
    param(
        [string]$Label,
        [scriptblock]$Command
    )
    & $Command
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [X] $Label failed (exit $LASTEXITCODE)."
        Exit-Install $LASTEXITCODE
    }
}

function Offer-CowcodeNodeJs {
    param([Parameter(Mandatory = $true)][string]$Reason)
    Write-Host ""
    Write-Host "  [X] $Reason"
    Write-Host ""
    Write-Host "  This step runs in PowerShell only. Node.js is not needed to download"
    Write-Host "  cowCode, but it is required for npm install, setup, and running the bot."
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") {
        try {
            if (Get-Command winget -ErrorAction SilentlyContinue) {
                $answer = Read-Host "  Install Node.js LTS with winget now? [Y/n]"
                if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[yY]') {
                    Write-Host "  > Installing Node.js LTS via winget..."
                    & winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
                    Write-Host ""
                    Write-Host "  When winget finishes, close this window and open a NEW PowerShell."
                    Write-Host "  Then run:  node -v   and   npm -v   and run this installer again."
                    Exit-Install 0
                }
            }
            $open = Read-Host "  Open https://nodejs.org/ in your browser? [Y/n]"
            if ([string]::IsNullOrWhiteSpace($open) -or $open -match '^[yY]') {
                Start-Process "https://nodejs.org/"
            }
        } catch {
            Write-Host "  Install from: https://nodejs.org/"
        }
    } else {
        Write-Host "  Install from: https://nodejs.org/"
    }
    Write-Host "  Open a new PowerShell window after installing, then run the installer again."
    Exit-Install 1
}

function Refresh-NpmGlobalPath {
    $npmGlobal = Join-Path $env:APPDATA "npm"
    if ((Test-Path $npmGlobal) -and ($env:Path -notlike "*$npmGlobal*")) {
        $env:Path = "$npmGlobal;$env:Path"
    }
}

function Test-CowcodePm2 {
    Refresh-NpmGlobalPath
    return [bool](Get-Command pm2 -ErrorAction SilentlyContinue)
}

function Ensure-CowcodePm2 {
    if (Test-CowcodePm2) {
        return $true
    }
    Write-Host ""
    Write-Host "  pm2 is required to run cowCode in the background on Windows."
    Write-Host "  (Like Node.js, it is not needed to download the code, only to keep the bot running.)"
    Write-Host ""
    if ($Host.Name -eq "ConsoleHost") {
        try {
            $answer = Read-Host "  Install pm2 globally now (npm install -g pm2)? [Y/n]"
            if ($answer -match '^[nN]') {
                Write-Host "  Install manually, then run this installer again or: cowcode start"
                Write-Host "    npm install -g pm2"
                return $false
            }
        } catch {
            Write-Host "  Install manually: npm install -g pm2"
            return $false
        }
    } else {
        Write-Host "  Install manually: npm install -g pm2"
        return $false
    }
    Write-Host "  > Installing pm2 globally..."
    Invoke-Native "npm install -g pm2" { npm install -g pm2 }
    Refresh-NpmGlobalPath
    if (-not (Test-CowcodePm2)) {
        Write-Host "  [X] pm2 still not found. Close PowerShell, open a new window, and run:"
        Write-Host "      npm install -g pm2"
        return $false
    }
    Write-Host "  [OK] pm2 installed."
    return $true
}

function Enable-CowcodePm2AutoRestart {
    if (-not (Test-CowcodePm2)) { return $false }

    Write-Host "  > Saving pm2 process list..."
    & pm2 save 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN] pm2 save failed."
        return $false
    }

    $wantAuto = $true
    if ($Host.Name -eq "ConsoleHost") {
        try {
            $answer = Read-Host "  Start cowCode automatically when you log in to Windows? [Y/n]"
            if ($answer -match '^[nN]') { $wantAuto = $false }
        } catch { }
    }
    if (-not $wantAuto) {
        Write-Host "  Skipped auto-start. Enable later:"
        Write-Host "    pm2 startup"
        Write-Host "    pm2 save"
        return $false
    }

    Write-Host "  > Configuring pm2 auto-start..."
    $startupLines = @(& pm2 startup 2>&1)
    foreach ($line in $startupLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        Write-Host "  $line"
    }
    $adminCmd = ($startupLines | Where-Object { $_ -match 'pm2\.exe startup|PM2.*copy/paste|Run the following' } | Select-Object -First 1)
    if ($adminCmd) {
        Write-Host "  If pm2 printed an admin command above, run it in an elevated PowerShell, then: pm2 save"
    }
    & pm2 save 2>$null
    Write-Host "  [OK] Auto-start configured (pm2 save)."
    return $true
}

function Show-CowcodePostInstallHelp {
    param(
        [bool]$Running = $false
    )
    $stateDir = Join-Path $env:USERPROFILE ".cowcode"
    Write-Host ""
    Write-Host "  ------------------------------------------------"
    Write-Host "  Useful commands"
    Write-Host "  ------------------------------------------------"
    Write-Host "  cowcode status       check if the bot is running"
    Write-Host "  pm2 status           same (all pm2 processes)"
    Write-Host "  cowcode logs         live log output"
    Write-Host "  pm2 logs cowcode     same"
    Write-Host "  cowcode stop         stop the background bot"
    Write-Host "  cowcode restart      restart after config changes"
    Write-Host "  cowcode dashboard    open the web dashboard"
    Write-Host "  cowcode update       pull the latest version"
    Write-Host ""
    Write-Host "  Log files:"
    Write-Host "    $stateDir\daemon.log"
    Write-Host "    $stateDir\daemon.err"
    if ($Running) {
        Write-Host ""
        Write-Host "  [OK] Bot is running in the background. You can close this window."
    } else {
        Write-Host ""
        Write-Host "  Start the bot: cowcode start"
    }
    Write-Host ""
}

function Test-CowcodeBranchName {
    param([Parameter(Mandatory = $true)][string]$Branch)
    if ([string]::IsNullOrWhiteSpace($Branch)) { return $false }
    if ($Branch.Length -gt 250) { return $false }
    if ($Branch -match '\.\.') { return $false }
    if ($Branch -match '[\x00-\x1f\x7f\\]') { return $false }
    return $true
}

function Encode-GitHubBranchPath {
    param([Parameter(Mandatory = $true)][string]$Branch)
    $encoded = foreach ($part in ($Branch -split '/')) {
        [uri]::EscapeDataString($part)
    }
    return ($encoded -join '/')
}

function Get-CowcodeRequestHeaders {
    param([string]$Accept = "*/*")
    @{
        "User-Agent"     = "cowcode-install/windows"
        "Cache-Control"  = "no-cache"
        "Pragma"         = "no-cache"
        "Accept"         = $Accept
    }
}

function Save-CowcodeDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [Parameter(Mandatory = $true)][string]$Label,
        [int]$TimeoutSec = 600,
        [int]$MinBytes = 64
    )
    $parent = Split-Path -Parent $OutFile
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    try {
        $null = Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing `
            -Headers (Get-CowcodeRequestHeaders) -TimeoutSec $TimeoutSec
    } catch {
        $status = $null
        if ($_.Exception -and $_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
        }
        $detail = if ($status) { "HTTP $status" } else { $_.Exception.Message }
        Write-Host "  [X] $Label failed: $detail"
        Exit-Install 1
    }
    if (-not (Test-Path -LiteralPath $OutFile)) {
        Write-Host "  [X] $Label failed: output file missing."
        Exit-Install 1
    }
    $len = (Get-Item -LiteralPath $OutFile).Length
    if ($len -lt $MinBytes) {
        Write-Host "  [X] $Label failed: download too small ($len bytes)."
        Exit-Install 1
    }
}

function Read-PackageJsonVersion {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        $pkg = $raw | ConvertFrom-Json
        $ver = $pkg.version
        if ($ver -is [string] -and $ver -match '^\d+\.\d+\.\d+') { return $ver.Trim() }
    } catch {
        Write-Host "  [WARN] Invalid package.json at $Path : $($_.Exception.Message)"
    }
    return $null
}

function Invoke-CowcodeBuildInfo {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Branch
    )
    $buildJs = Join-Path $Root "lib\build-info.js"
    if (-not (Test-Path -LiteralPath $buildJs)) { return }
    Push-Location $Root
    try {
        $env:COWCODE_BRANCH = $Branch
        $null = node --input-type=module -e @"
import { fetchRemoteBuild, writeBuild } from './lib/build-info.js';
const root = process.cwd().replace(/\\/g, '/');
const branch = process.env.COWCODE_BRANCH || 'master';
const b = await fetchRemoteBuild(branch);
if (b) writeBuild(root, b);
"@ 2>$null
    } catch {
        Write-Host "  [WARN] Build metadata skipped: $($_.Exception.Message)"
    } finally {
        Pop-Location
        Remove-Item Env:COWCODE_BRANCH -ErrorAction SilentlyContinue
    }
}

function Copy-CowcodeTree {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$DestDir
    )
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
    foreach ($item in Get-ChildItem -Path $SourceDir -Force) {
        if ($item.Name -eq "node_modules") { continue }
        $dest = Join-Path $DestDir $item.Name
        try {
            if (Test-Path -LiteralPath $dest) {
                Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop
            }
            Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Host "  [X] Failed to copy $($item.Name): $($_.Exception.Message)"
            Exit-Install 1
        }
    }
}

Write-Host ""
Write-Host "  Welcome to cowCode - WhatsApp bot with your own LLM"
Write-Host "  ------------------------------------------------"
Write-Host ""

# --- sanity checks (before download; PowerShell-only until npm install) ---
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Offer-CowcodeNodeJs "Node.js was not found on PATH."
}

$hasPnpm = [bool](Get-Command pnpm -ErrorAction SilentlyContinue)
$hasNpm = [bool](Get-Command npm -ErrorAction SilentlyContinue)
if (-not $hasPnpm -and -not $hasNpm) {
    $reason = "npm (or pnpm) was not found on PATH."
    if ($nodeCmd.Source -match "cursor|Cursor") {
        $reason = "Node from Cursor was found, but that build does not include npm."
    }
    Offer-CowcodeNodeJs $reason
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Host "  [X] tar is required (Windows 10+ built-in tar, or install Git for Windows)."
    Exit-Install 1
}

$Branch = if ($env:COWCODE_BRANCH) { $env:COWCODE_BRANCH.Trim() } else { "master" }
if (-not (Test-CowcodeBranchName $Branch)) {
    Write-Host "  [X] Invalid branch name in COWCODE_BRANCH."
    Exit-Install 1
}

$BranchPath = Encode-GitHubBranchPath $Branch
$Tarball = "https://github.com/bishwashere/cowcode/archive/refs/heads/$BranchPath.tar.gz"
$Extracted = "cowCode-$Branch"

$InstallDir = if ($env:COWCODE_INSTALL_DIR) { $env:COWCODE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".local\share\cowcode" }
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
$Launcher = Join-Path $BinDir "cowcode.cmd"

# --- temp workspace ---
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("cowcode-install-" + [guid]::NewGuid().ToString("n"))
try {
    New-Item -ItemType Directory -Path $Work -Force | Out-Null
} catch {
    Write-Host "  [X] Could not create temp directory: $($_.Exception.Message)"
    Exit-Install 1
}

try {
    # --- download ---
    Write-Host "  > Downloading (branch: $Branch)..."
    $Archive = Join-Path $Work "archive.tar.gz"
    Save-CowcodeDownload -Uri $Tarball -OutFile $Archive -Label "Download release tarball" -MinBytes 1024
    Invoke-Native "Extract archive" { tar -xzf $Archive -C $Work }
    Write-Host "  [OK] Done."
    Write-Host ""

    # --- install code ---
    Write-Host "  > Installing to $InstallDir ..."
    $Src = Join-Path $Work $Extracted
    if (-not (Test-Path -LiteralPath $Src)) {
        Write-Host "  [X] Extracted folder not found: $Src"
        Write-Host "  [X] Check COWCODE_BRANCH (archive root must be cowCode-<branch>)."
        Exit-Install 1
    }

    Copy-CowcodeTree -SourceDir $Src -DestDir $InstallDir

    $pkgPath = Join-Path $InstallDir "package.json"
    if (-not (Test-Path -LiteralPath $pkgPath) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir "index.js"))) {
        Write-Host "  [X] Install incomplete: package.json or index.js missing under $InstallDir"
        Exit-Install 1
    }

    $ver = Read-PackageJsonVersion $pkgPath
    Invoke-CowcodeBuildInfo -Root $InstallDir -Branch $Branch
    if ($ver) {
        Write-Host "  [OK] Code installed (v$ver)."
    } else {
        Write-Host "  [OK] Code installed."
    }
    Write-Host ""

    # --- launcher ---
    Write-Host "  > Installing launcher..."
    try {
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
        if ($InstallDir -match '"') {
            Write-Host "  [X] Install path cannot contain double quotes: $InstallDir"
            Exit-Install 1
        }
        $cmdContent = @"
@echo off
set COWCODE_INSTALL_DIR=$InstallDir
node "$InstallDir\cli.js" %*
"@
        Set-Content -Path $Launcher -Value $cmdContent -Encoding ASCII -ErrorAction Stop
    } catch {
        Write-Host "  [X] Launcher install failed: $($_.Exception.Message)"
        Exit-Install 1
    }
    Write-Host "  > Launcher installed: $Launcher"

    # --- PATH ---
    try {
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -notlike "*$BinDir*") {
            $newPath = if ($userPath) { "$BinDir;$userPath" } else { $BinDir }
            [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
            $env:Path = "$BinDir;$env:Path"
            Write-Host "  > Added $BinDir to user PATH (open a new terminal if cowcode is not found)"
        }
    } catch {
        Write-Host "  [WARN] Could not update user PATH: $($_.Exception.Message)"
        Write-Host "  [WARN] Add manually: $BinDir"
    }
    Write-Host ""

    # --- dependencies (must run before setup.js) ---
    Write-Host "  > Installing dependencies..."
    Push-Location $InstallDir
    try {
        $hasDotenv = Test-Path (Join-Path $InstallDir "node_modules\dotenv")
        if ($hasDotenv) {
            Write-Host "  [OK] Dependencies already installed."
        } elseif ($hasPnpm) {
            Invoke-Native "pnpm install" { pnpm install }
            Write-Host "  [OK] Dependencies installed."
        } else {
            Invoke-Native "npm install" { npm install }
            Write-Host "  [OK] Dependencies installed."
        }
        if (-not (Test-Path (Join-Path $InstallDir "node_modules\dotenv"))) {
            Write-Host "  [X] Dependencies missing after install (node_modules/dotenv)."
            Exit-Install 1
        }
    } finally {
        Pop-Location
    }
    Write-Host ""

    # --- setup ---
    if ($SkipSetup) {
        Write-Host "  [OK] Setup skipped."
    } else {
        Write-Host "  > Setting up (config + WhatsApp link)..."
        Write-Host "  (When you are done and want to stop the bot, press Ctrl+C.)"
        Write-Host ""
        Push-Location $InstallDir
        try {
            node setup.js
            if ($LASTEXITCODE -ne 0) {
                Write-Host "  [WARN] Setup exited with code $LASTEXITCODE."
            }
        } catch {
            Write-Host "  [WARN] Setup exited: $($_.Exception.Message)"
        } finally {
            Pop-Location
        }
    }

    Write-Host ""
    Write-Host "  ------------------------------------------------"

    $env:COWCODE_INSTALL_DIR = $InstallDir
    $env:Path = "$BinDir;$env:Path"
    Refresh-NpmGlobalPath

    if (-not (Ensure-CowcodePm2)) {
        Show-CowcodePostInstallHelp -Running $false
        Exit-Install 1
    }

    Write-Host "  > Starting cowCode with pm2..."
    & node "$InstallDir\cli.js" start
    $started = ($LASTEXITCODE -eq 0)

    if ($started) {
        $null = Enable-CowcodePm2AutoRestart
    }

    Show-CowcodePostInstallHelp -Running $started
    if (-not $started) {
        Exit-Install 1
    }
} finally {
    if (Test-Path -LiteralPath $Work) {
        Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
