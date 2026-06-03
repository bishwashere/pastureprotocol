# cowCode Windows update - same flow as update.sh (no bash required)
param(
    [switch]$Force
)

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Exit-Update {
    param([int]$Code = 0)
    if ($Code -ne 0 -and $Host.Name -eq "ConsoleHost") {
        Write-Host ""
        try { Read-Host "Press Enter to close" } catch { }
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
        Exit-Update $LASTEXITCODE
    }
}

function Refresh-NodeToolPath {
    $toAdd = @()
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

function Get-CowcodeToolPath {
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

function Get-CowcodeNodeVersion {
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

function Get-CowcodeToolNodeVersion {
    param([string]$ToolPath)
    if ($ToolPath) {
        $toolDir = Split-Path $ToolPath -Parent
        $adjacentNode = Join-Path $toolDir "node.exe"
        if (Test-Path -LiteralPath $adjacentNode) {
            return Get-CowcodeNodeVersion $adjacentNode
        }
    }
    return Get-CowcodeNodeVersion $null
}

function Test-CowcodeSupportedNode {
    param([object]$Version)
    if (-not $Version) { return $false }
    return ($Version.Major -ge 18 -and $Version.Major -le 22)
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
        "User-Agent"     = "cowcode-update/windows"
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
        [int]$MinBytes = 64,
        [switch]$AllowFail
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
        if ($AllowFail) {
            Write-Host "  [WARN] $Label failed: $detail"
            return $false
        }
        Write-Host "  [X] $Label failed: $detail"
        Exit-Update 1
    }
    if (-not (Test-Path -LiteralPath $OutFile)) {
        if ($AllowFail) {
            Write-Host "  [WARN] $Label failed: output file missing."
            return $false
        }
        Write-Host "  [X] $Label failed: output file missing."
        Exit-Update 1
    }
    $len = (Get-Item -LiteralPath $OutFile).Length
    if ($len -lt $MinBytes) {
        if ($AllowFail) {
            Write-Host "  [WARN] $Label failed: download too small ($len bytes)."
            return $false
        }
        Write-Host "  [X] $Label failed: download too small ($len bytes)."
        Exit-Update 1
    }
    return $true
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
    if (-not (Test-Path -LiteralPath $buildJs)) { return $null }
    Push-Location $Root
    try {
        $env:COWCODE_BRANCH = $Branch
        $out = node --input-type=module -e @"
import { fetchRemoteBuild, writeBuild } from './lib/build-info.js';
const root = process.cwd().replace(/\\/g, '/');
const branch = process.env.COWCODE_BRANCH || 'master';
const b = await fetchRemoteBuild(branch);
if (b) writeBuild(root, b);
if (b) console.log(b);
"@ 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return "$out".Trim() }
    } catch {
        Write-Host "  [WARN] Build metadata skipped: $($_.Exception.Message)"
    } finally {
        Pop-Location
        Remove-Item Env:COWCODE_BRANCH -ErrorAction SilentlyContinue
    }
    return $null
}

function Copy-CowcodeTree {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$DestDir
    )
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
            Exit-Update 1
        }
    }
}

$Branch = if ($env:COWCODE_BRANCH) { $env:COWCODE_BRANCH.Trim() } else { "master" }
if (-not (Test-CowcodeBranchName $Branch)) {
    Write-Host "  [X] Invalid branch name in COWCODE_BRANCH."
    Exit-Update 1
}

$BranchPath = Encode-GitHubBranchPath $Branch
$Tarball = "https://github.com/bishwashere/cowcode/archive/refs/heads/$BranchPath.tar.gz"
$Extracted = "cowCode-$Branch"

$Root = if ($env:COWCODE_ROOT) { $env:COWCODE_ROOT } elseif ($env:COWCODE_INSTALL_DIR) { $env:COWCODE_INSTALL_DIR } else { $PSScriptRoot }
$StateDir = if ($env:COWCODE_STATE_DIR) { $env:COWCODE_STATE_DIR } else { Join-Path $env:USERPROFILE ".cowcode" }

if (-not (Test-Path (Join-Path $Root "package.json")) -or -not (Test-Path (Join-Path $Root "index.js"))) {
    Write-Host ""
    Write-Host "  Run from inside your cowCode folder, or use:  cowcode update"
    Write-Host ""
    Exit-Update 1
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("cowcode-update-" + [guid]::NewGuid().ToString("n"))
try {
    New-Item -ItemType Directory -Path $Work -Force | Out-Null
} catch {
    Write-Host "  [X] Could not create temp directory: $($_.Exception.Message)"
    Exit-Update 1
}

try {
    if (-not $Force) {
        $localVer = Read-PackageJsonVersion (Join-Path $Root "package.json")
        $remoteJson = Join-Path $Work "remote_package.json"
        $ts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $pkgUri = "https://raw.githubusercontent.com/bishwashere/cowcode/$BranchPath/package.json?t=$ts"
        if (Save-CowcodeDownload -Uri $pkgUri -OutFile $remoteJson -Label "Fetch remote package.json" `
            -MinBytes 16 -TimeoutSec 120 -AllowFail) {
            $remoteVer = Read-PackageJsonVersion $remoteJson
            if ($localVer -and $remoteVer -and ($localVer -eq $remoteVer)) {
                Write-Host ""
                Write-Host "  Already up to date (v$localVer)."
                Write-Host ""
                exit 0
            }
        } else {
            Write-Host "  [WARN] Version check skipped; continuing update."
        }
    }

    Write-Host ""
    Write-Host "  cowCode - Updating..."
    Write-Host "  ------------------------------------------------"
    Write-Host ""

    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null

    Write-Host "  > Downloading latest..."
    $Archive = Join-Path $Work "archive.tar.gz"
    $null = Save-CowcodeDownload -Uri $Tarball -OutFile $Archive -Label "Download release tarball" -MinBytes 1024
    Invoke-Native "Extract archive" { tar -xzf $Archive -C $Work }
    $Src = Join-Path $Work $Extracted
    if (-not (Test-Path -LiteralPath $Src)) {
        Write-Host "  [X] Extracted folder not found: $Src"
        Exit-Update 1
    }

    Write-Host "  > Updating files..."
    Copy-CowcodeTree -SourceDir $Src -DestDir $Root

    Write-Host "  > Installing dependencies..."
    Push-Location $Root
    try {
        Refresh-NodeToolPath
        $npmCmd = Get-CowcodeToolPath "npm"
        $pnpmCmd = Get-CowcodeToolPath "pnpm"
        if (-not $npmCmd -and -not $pnpmCmd) {
            Write-Host "  [X] npm.cmd not found. Install Node.js from https://nodejs.org/"
            Exit-Update 1
        }
        $packageManagerNode = if ($pnpmCmd) { Get-CowcodeToolNodeVersion $pnpmCmd } else { Get-CowcodeToolNodeVersion $npmCmd }
        if (-not (Test-CowcodeSupportedNode $packageManagerNode)) {
            $found = if ($packageManagerNode) { $packageManagerNode.Raw } else { "unknown" }
            Write-Host "  [X] Unsupported Node.js version used by npm/pnpm: $found"
            Write-Host "  cowCode needs Node.js 18, 20, or 22 LTS on Windows."
            Write-Host "  Install Node.js LTS from https://nodejs.org/ then open a new PowerShell."
            Exit-Update 1
        }
        if (Test-Path "node_modules") {
            Remove-Item -Path "node_modules" -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($pnpmCmd) {
            Invoke-Native "pnpm install" { & $pnpmCmd install --silent }
        } else {
            Invoke-Native "npm install" { & $npmCmd install --silent }
        }
    } finally {
        Pop-Location
    }

    $null = Invoke-CowcodeBuildInfo -Root $Root -Branch $Branch

    $nowVer = Read-PackageJsonVersion (Join-Path $Root "package.json")
    Write-Host ""
    if ($nowVer) {
        Write-Host "  [OK] Update complete. Now at v$nowVer"
    } else {
        Write-Host "  [OK] Update complete."
    }
    Write-Host "  Start the bot:  cowcode start"
    Write-Host "  If already running, restart:  cowcode restart"
    Write-Host ""
} finally {
    if (Test-Path -LiteralPath $Work) {
        Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
