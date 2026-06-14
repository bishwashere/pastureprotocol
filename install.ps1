# Pasture Protocol Windows installer
# Download -> install -> deps -> setup -> start (pm2)
# Code: %USERPROFILE%\.local\share\pastureprotocol   State: %USERPROFILE%\.pasture
# Install: iwr -useb https://raw.githubusercontent.com/bishwashere/pastureprotocol/master/install.ps1 | iex

param(
    [switch]$SkipSetup
)

# Windows PowerShell 5.1: "Stop" treats native stderr (npm/tar/node) as fatal and closes the window.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

$PastureNodeVersion = "v22.16.0"
$PastureNodeZipName = "node-$PastureNodeVersion-win-x64"
$PastureNodeRoot = Join-Path $env:LOCALAPPDATA "pastureprotocol\node"
$PastureNodeDir = Join-Path $PastureNodeRoot $PastureNodeZipName

function Test-PastureInteractive {
    if ($env:PASTURE_NONINTERACTIVE -eq "1" -or $env:PASTURE_NONINTERACTIVE -eq "1") { return $false }
    return ($Host.Name -eq "ConsoleHost")
}

function Exit-Install {
    param([int]$Code = 0)
    if ($Code -ne 0) {
        Write-Host ""
        Write-Host "  [X] Install failed (exit $Code). See messages above."
        if (Test-PastureInteractive) {
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

function Use-PastureNodeRuntime {
    if (Test-Path -LiteralPath (Join-Path $PastureNodeDir "node.exe")) {
        if ($env:Path -notlike "*$PastureNodeDir*") {
            $env:Path = "$PastureNodeDir;$env:Path"
        }
        return $true
    }
    return $false
}

function Install-PastureNodeRuntime {
    Write-Host "  > Installing Pasture Protocol-managed Node.js 22 runtime..."
    try {
        New-Item -ItemType Directory -Path $PastureNodeRoot -Force | Out-Null
        $work = Join-Path ([System.IO.Path]::GetTempPath()) ("pasture-node-" + [guid]::NewGuid().ToString("n"))
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        $zip = Join-Path $work "node.zip"
        $url = "https://nodejs.org/dist/$PastureNodeVersion/$PastureNodeZipName.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
        if (Test-Path -LiteralPath $PastureNodeDir) {
            Remove-Item -LiteralPath $PastureNodeDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        Expand-Archive -Path $zip -DestinationPath $PastureNodeRoot -Force
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Use-PastureNodeRuntime)) {
            Write-Host "  [X] Managed Node.js install did not produce node.exe."
            return $false
        }
        Write-Host "  [OK] Node.js runtime installed: $PastureNodeDir"
        return $true
    } catch {
        Write-Host "  [X] Managed Node.js install failed: $($_.Exception.Message)"
        return $false
    }
}

function Offer-PastureNodeJs {
    param([Parameter(Mandatory = $true)][string]$Reason)
    Write-Host ""
    Write-Host "  [X] $Reason"
    Write-Host ""
    Write-Host "  Pasture Protocol needs Node.js 18, 20, or 22 on Windows because native"
    Write-Host "  dependencies like better-sqlite3 do not have Node 24 prebuilds yet."
    Write-Host "  The installer can install a private Node.js 22 runtime for Pasture Protocol."
    Write-Host ""
    if (Test-PastureInteractive) {
        try {
            $answer = Read-Host "  Install Pasture Protocol-managed Node.js 22 now? [Y/n]"
            if ($answer -match '^[nN]') {
                Write-Host "  Install Node.js 22 LTS manually, then open a new PowerShell and rerun this installer."
                Exit-Install 1
            }
        } catch {
            Write-Host "  Install Node.js 22 LTS manually, then rerun this installer."
            Exit-Install 1
        }
    }
    if (-not (Install-PastureNodeRuntime)) {
        Exit-Install 1
    }
}

function Refresh-NpmGlobalPath {
    $npmGlobal = Join-Path $env:APPDATA "npm"
    if ((Test-Path $npmGlobal) -and ($env:Path -notlike "*$npmGlobal*")) {
        $env:Path = "$npmGlobal;$env:Path"
    }
}

function Refresh-NodeToolPath {
    $toAdd = @()
    if (Use-PastureNodeRuntime) {
        $toAdd += $PastureNodeDir
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        $toAdd += (Join-Path $env:ProgramFiles "nodejs")
        $toAdd += (Join-Path ${env:ProgramFiles(x86)} "nodejs")
    }
    $toAdd += (Join-Path $env:APPDATA "npm")
    foreach ($d in $toAdd) {
        if ((Test-Path $d) -and ($env:Path -notlike "*$d*")) {
            $env:Path = "$env:Path;$d"
        }
    }
}

function Get-PastureToolPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeDir = Split-Path $nodeCmd.Source -Parent
        $adjacent = Join-Path $nodeDir "$Name.cmd"
        if (Test-Path -LiteralPath $adjacent) { return $adjacent }
    }
    $candidates = @(
        (Join-Path $env:APPDATA "npm\$Name.cmd"),
        (Join-Path $env:ProgramFiles "nodejs\$Name.cmd"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\$Name.cmd")
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $cmd = Get-Command "$Name.cmd" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Get-PastureNodeVersion {
    param([string]$NodePath)
    try {
        $out = if ($NodePath) { & $NodePath -v 2>$null } else { node -v 2>$null }
        if ($LASTEXITCODE -eq 0 -and $out -match '^v?(\d+)\.') {
            return [pscustomobject]@{
                Major = [int]$Matches[1]
                Raw   = "$out"
            }
        }
    } catch { }
    return $null
}

function Get-PastureToolNodeVersion {
    param([string]$ToolPath)
    if ($ToolPath) {
        $toolDir = Split-Path $ToolPath -Parent
        $adjacentNode = Join-Path $toolDir "node.exe"
        if (Test-Path -LiteralPath $adjacentNode) {
            return Get-PastureNodeVersion $adjacentNode
        }
    }
    return Get-PastureNodeVersion $null
}

function Test-PastureSupportedNode {
    param([object]$Version)
    if (-not $Version) { return $false }
    return ($Version.Major -ge 18 -and $Version.Major -le 22)
}

function Test-PasturePm2 {
    Refresh-NodeToolPath
    return [bool](Get-PastureToolPath "pm2")
}

function Ensure-PasturePm2 {
    if (Test-PasturePm2) {
        return $true
    }
    Write-Host ""
    Write-Host "  pm2 is required to run Pasture Protocol in the background on Windows."
    Write-Host "  (Like Node.js, it is not needed to download the code, only to keep the bot running.)"
    Write-Host ""
    if (Test-PastureInteractive) {
        try {
            $answer = Read-Host "  Install pm2 globally now (npm install -g pm2)? [Y/n]"
            if ($answer -match '^[nN]') {
                Write-Host "  Install manually, then run this installer again or: pasture start"
                Write-Host "    npm install -g pm2"
                return $false
            }
        } catch {
            Write-Host "  Install manually: npm install -g pm2"
            return $false
        }
    } elseif (-not (Test-PastureInteractive)) {
        # Non-interactive (CI/E2E): install pm2 automatically
        Write-Host "  > Installing pm2 (non-interactive)..."
    } else {
        Write-Host "  Install manually: npm install -g pm2"
        return $false
    }
    Write-Host "  > Installing pm2 globally..."
    $npmCmd = Get-PastureToolPath "npm"
    if (-not $npmCmd) {
        Write-Host "  [X] npm.cmd not found."
        return $false
    }
    Invoke-Native "npm install -g pm2" { & $npmCmd install -g pm2 }
    Refresh-NodeToolPath
    if (-not (Test-PasturePm2)) {
        Write-Host "  [X] pm2 still not found. Close PowerShell, open a new window, and run:"
        Write-Host "      npm install -g pm2"
        return $false
    }
    Write-Host "  [OK] pm2 installed."
    return $true
}

function Enable-PasturePm2AutoRestart {
    if (-not (Test-PasturePm2)) { return $false }
    $pm2Cmd = Get-PastureToolPath "pm2"
    if (-not $pm2Cmd) { return $false }

    Write-Host "  > Saving pm2 process list..."
    & $pm2Cmd save 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [WARN] pm2 save failed."
        return $false
    }

    $wantAuto = $false
    if (Test-PastureInteractive) {
        try {
            $wantAuto = $true
            $answer = Read-Host "  Start Pasture Protocol automatically when you log in to Windows? [Y/n]"
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
    $startupLines = @(& $pm2Cmd startup 2>&1)
    foreach ($line in $startupLines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        Write-Host "  $line"
    }
    $adminCmd = ($startupLines | Where-Object { $_ -match 'pm2\.exe startup|PM2.*copy/paste|Run the following' } | Select-Object -First 1)
    if ($adminCmd) {
        Write-Host "  If pm2 printed an admin command above, run it in an elevated PowerShell, then: pm2 save"
    }
    & $pm2Cmd save 2>$null
    Write-Host "  [OK] Auto-start configured (pm2 save)."
    return $true
}

function Show-PasturePostInstallHelp {
    param(
        [bool]$Running = $false
    )
    $stateDir = Join-Path $env:USERPROFILE ".pasture"
    Write-Host ""
    Write-Host "  ------------------------------------------------"
    Write-Host "  Useful commands"
    Write-Host "  ------------------------------------------------"
    Write-Host "  pasture status       check if the bot is running"
    Write-Host "  pm2 status           same (all pm2 processes)"
    Write-Host "  pasture logs         live log output"
    Write-Host "  pm2 logs pasture     same"
    Write-Host "  pasture stop         stop the background bot"
    Write-Host "  pasture restart      restart after config changes"
    Write-Host "  pasture dashboard    open the web dashboard"
    Write-Host "  pasture update       pull the latest version"
    Write-Host ""
    Write-Host "  Log files:"
    Write-Host "    $stateDir\daemon.log"
    Write-Host "    $stateDir\daemon.err"
    if ($Running) {
        Write-Host ""
        Write-Host "  [OK] Bot is running in the background. You can close this window."
    } else {
        Write-Host ""
        Write-Host "  Start the bot: pasture start"
    }
    Write-Host ""
}

function Test-PastureBranchName {
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

function Get-PastureRequestHeaders {
    param([string]$Accept = "*/*")
    @{
        "User-Agent"     = "pasture-install/windows"
        "Cache-Control"  = "no-cache"
        "Pragma"         = "no-cache"
        "Accept"         = $Accept
    }
}

function Save-PastureDownload {
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
            -Headers (Get-PastureRequestHeaders) -TimeoutSec $TimeoutSec
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

function Invoke-PastureBuildInfo {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Branch
    )
    $buildJs = Join-Path $Root "lib\build-info.js"
    if (-not (Test-Path -LiteralPath $buildJs)) { return }
    Push-Location $Root
    try {
        $env:PASTURE_BRANCH = $Branch
        $null = node --input-type=module -e @"
import { fetchRemoteBuild, writeBuild } from './lib/build-info.js';
const root = process.cwd().replace(/\\/g, '/');
const branch = process.env.PASTURE_BRANCH || 'master';
const b = await fetchRemoteBuild(branch);
if (b) writeBuild(root, b);
"@ 2>$null
    } catch {
        Write-Host "  [WARN] Build metadata skipped: $($_.Exception.Message)"
    } finally {
        Pop-Location
        Remove-Item Env:PASTURE_BRANCH -ErrorAction SilentlyContinue
    }
}

function Copy-PastureTree {
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
Write-Host "  Welcome to Pasture Protocol - WhatsApp bot with your own LLM"
Write-Host "  ------------------------------------------------"
Write-Host ""

# --- sanity checks (before download; PowerShell-only until npm install) ---
Refresh-NodeToolPath
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Offer-PastureNodeJs "Node.js was not found on PATH."
    Refresh-NodeToolPath
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
}
$nodeVersion = Get-PastureNodeVersion $nodeCmd.Source
if (-not (Test-PastureSupportedNode $nodeVersion)) {
    $found = if ($nodeVersion) { $nodeVersion.Raw } else { "unknown" }
    Offer-PastureNodeJs "Unsupported Node.js version found ($found). Pasture Protocol needs Node.js 18, 20, or 22 LTS on Windows."
    Refresh-NodeToolPath
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $nodeVersion = Get-PastureNodeVersion $nodeCmd.Source
    if (-not (Test-PastureSupportedNode $nodeVersion)) {
        $found = if ($nodeVersion) { $nodeVersion.Raw } else { "unknown" }
        Write-Host "  [X] Still using unsupported Node.js after managed install: $found"
        Exit-Install 1
    }
}

$npmCmd = Get-PastureToolPath "npm"
$pnpmCmd = Get-PastureToolPath "pnpm"
$hasPnpm = [bool]$pnpmCmd
$hasNpm = [bool]$npmCmd
if (-not $hasPnpm -and -not $hasNpm) {
    $reason = "npm (or pnpm) was not found on PATH."
    if ($nodeCmd.Source -match "cursor|Cursor") {
        $reason = "Node from Cursor was found, but that build does not include npm."
    }
    Offer-PastureNodeJs $reason
    Refresh-NodeToolPath
    $npmCmd = Get-PastureToolPath "npm"
    $pnpmCmd = Get-PastureToolPath "pnpm"
    $hasPnpm = [bool]$pnpmCmd
    $hasNpm = [bool]$npmCmd
}
$packageManagerNode = if ($hasPnpm) { Get-PastureToolNodeVersion $pnpmCmd } else { Get-PastureToolNodeVersion $npmCmd }
if (-not (Test-PastureSupportedNode $packageManagerNode)) {
    $found = if ($packageManagerNode) { $packageManagerNode.Raw } else { "unknown" }
    Offer-PastureNodeJs "npm/pnpm is using unsupported Node.js ($found). Pasture Protocol needs Node.js 18, 20, or 22 LTS on Windows."
    Refresh-NodeToolPath
    $npmCmd = Get-PastureToolPath "npm"
    $pnpmCmd = Get-PastureToolPath "pnpm"
    $hasPnpm = [bool]$pnpmCmd
    $hasNpm = [bool]$npmCmd
    $packageManagerNode = if ($hasPnpm) { Get-PastureToolNodeVersion $pnpmCmd } else { Get-PastureToolNodeVersion $npmCmd }
    if (-not (Test-PastureSupportedNode $packageManagerNode)) {
        $found = if ($packageManagerNode) { $packageManagerNode.Raw } else { "unknown" }
        Write-Host "  [X] npm/pnpm is still using unsupported Node.js after managed install: $found"
        Exit-Install 1
    }
}

if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Write-Host "  [X] tar is required (Windows 10+ built-in tar, or install Git for Windows)."
    Exit-Install 1
}

$Branch = if ($env:PASTURE_BRANCH) { $env:PASTURE_BRANCH.Trim() } else { "master" }
if (-not (Test-PastureBranchName $Branch)) {
    Write-Host "  [X] Invalid branch name in PASTURE_BRANCH."
    Exit-Install 1
}

$BranchPath = Encode-GitHubBranchPath $Branch
$Tarball = "https://github.com/bishwashere/pastureprotocol/archive/refs/heads/$BranchPath.tar.gz"

$InstallDir = if ($env:PASTURE_INSTALL_DIR) { $env:PASTURE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".local\share\pastureprotocol" }
$BinDir = Join-Path $env:USERPROFILE ".local\bin"
$Launcher = Join-Path $BinDir "pasture.cmd"

# --- temp workspace ---
$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("pasture-install-" + [guid]::NewGuid().ToString("n"))
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
    $null = Save-PastureDownload -Uri $Tarball -OutFile $Archive -Label "Download release tarball" -MinBytes 1024
    Invoke-Native "Extract archive" { tar -xzf $Archive -C $Work }
    $SrcDir = Get-ChildItem -LiteralPath $Work -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $SrcDir) {
        Write-Host "  [X] Archive extract failed (no top-level folder)."
        Exit-Install 1
    }
    $Src = $SrcDir.FullName
    Write-Host "  [OK] Done."
    Write-Host ""

    # --- install code ---
    Write-Host "  > Installing to $InstallDir ..."
    Copy-PastureTree -SourceDir $Src -DestDir $InstallDir

    $pkgPath = Join-Path $InstallDir "package.json"
    if (-not (Test-Path -LiteralPath $pkgPath) -or -not (Test-Path -LiteralPath (Join-Path $InstallDir "index.js"))) {
        Write-Host "  [X] Install incomplete: package.json or index.js missing under $InstallDir"
        Exit-Install 1
    }

    $ver = Read-PackageJsonVersion $pkgPath
    Invoke-PastureBuildInfo -Root $InstallDir -Branch $Branch
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
set PASTURE_INSTALL_DIR=$InstallDir
set PASTURE_NODE_DIR=$PastureNodeDir
if exist "%PASTURE_NODE_DIR%\node.exe" set PATH=%PASTURE_NODE_DIR%;%APPDATA%\npm;%PATH%
if exist "%PASTURE_NODE_DIR%\node.exe" set PATH=%PASTURE_NODE_DIR%;%APPDATA%\npm;%PATH%
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
            Write-Host "  > Added $BinDir to user PATH (open a new terminal if pasture is not found)"
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
        } else {
            if (Test-Path (Join-Path $InstallDir "node_modules")) {
                Write-Host "  > Removing incomplete node_modules..."
                Remove-Item -Path (Join-Path $InstallDir "node_modules") -Recurse -Force -ErrorAction SilentlyContinue
            }
            if ($hasPnpm) {
            Invoke-Native "pnpm install" { & $pnpmCmd install }
            Write-Host "  [OK] Dependencies installed."
            } else {
            Invoke-Native "npm install" { & $npmCmd install }
            Write-Host "  [OK] Dependencies installed."
            }
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

    $env:PASTURE_INSTALL_DIR = $InstallDir
    $env:Path = "$BinDir;$env:Path"
    Refresh-NodeToolPath

    if (-not (Ensure-PasturePm2)) {
        Show-PasturePostInstallHelp -Running $false
        Exit-Install 1
    }

    Write-Host "  > Starting Pasture Protocol with pm2..."
    & node "$InstallDir\cli.js" start
    $started = ($LASTEXITCODE -eq 0)

    if ($started) {
        $null = Enable-PasturePm2AutoRestart
    }

    Show-PasturePostInstallHelp -Running $started
    if (-not $started) {
        Exit-Install 1
    }
} finally {
    if (Test-Path -LiteralPath $Work) {
        Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
