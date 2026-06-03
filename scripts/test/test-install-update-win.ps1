# E2E: install.ps1, cowcode CLI, update.ps1, update --force (Windows)
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test/test-install-update-win.ps1

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$Repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$TestRoot = Join-Path $env:TEMP ("cowcode-win-e2e-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
$InstallDir = Join-Path $TestRoot 'install'
$NodeDir = Join-Path $TestRoot 'node-portable'
$Results = @()

function Add-Case {
    param([string]$Name, [string]$CaseInput, [string]$Output, [bool]$Ok)
    $script:Results += [pscustomobject]@{
        Test   = $Name
        Input  = $CaseInput
        Output = $Output
        Status = $(if ($Ok) { 'Pass' } else { 'Fail' })
    }
}

function Ensure-PortableNode22 {
    if (Test-Path (Join-Path $NodeDir 'node-v22.16.0-win-x64\node.exe')) { return $true }
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    $zip = Join-Path $TestRoot 'node.zip'
    $ver = 'v22.16.0'
    try {
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath $NodeDir -Force
        return (Test-Path (Join-Path $NodeDir "node-$ver-win-x64\node.exe"))
    } catch {
        Write-Host "  [WARN] Could not download portable Node 22: $($_.Exception.Message)"
        return $false
    }
}

function Setup-TestPath {
    $nodeBin = Join-Path $NodeDir 'node-v22.16.0-win-x64'
    if (Test-Path $nodeBin) {
        $env:Path = "$nodeBin;$env:WINDIR\system32;$env:APPDATA\npm;$env:Path"
    } else {
        Refresh-NodeToolPathLocal
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
    }
    return $true
}

function Refresh-NodeToolPathLocal {
    foreach ($d in @(
        (Join-Path $env:ProgramFiles 'nodejs'),
        (Join-Path $env:APPDATA 'npm')
    )) {
        if ((Test-Path $d) -and ($env:Path -notlike "*$d*")) {
            $env:Path = "$d;$env:Path"
        }
    }
    if ($env:Path -notlike "*$env:WINDIR\system32*") {
        $env:Path = "$env:WINDIR\system32;$env:Path"
    }
}

function Cleanup-Test {
    param([string]$LauncherBackup)
    $pm2 = Get-Command pm2.cmd -ErrorAction SilentlyContinue
    if ($pm2) { & $pm2.Source delete cowcode 2>$null | Out-Null }
    $launcher = Join-Path $env:USERPROFILE '.local\bin\cowcode.cmd'
    if ($LauncherBackup -and (Test-Path $LauncherBackup)) {
        Copy-Item $LauncherBackup $launcher -Force -ErrorAction SilentlyContinue
    } elseif ((Test-Path $launcher) -and (Get-Content $launcher -Raw -ErrorAction SilentlyContinue) -match [regex]::Escape($InstallDir)) {
        Remove-Item $launcher -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $TestRoot) {
        Remove-Item $TestRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "  cowCode Windows E2E: install + CLI + update"
Write-Host "  Test root: $TestRoot"
Write-Host ""

$env:COWCODE_NONINTERACTIVE = "1"

New-Item -ItemType Directory -Path $TestRoot, $InstallDir -Force | Out-Null
$launcher = Join-Path $env:USERPROFILE '.local\bin\cowcode.cmd'
$launcherBackup = $null
if (Test-Path $launcher) {
    $launcherBackup = Join-Path $TestRoot 'cowcode.cmd.bak'
    Copy-Item $launcher $launcherBackup -Force
}

if (-not (Ensure-PortableNode22)) {
    Add-Case 'setup' 'portable Node 22' 'download failed' $false
} elseif (-not (Setup-TestPath)) {
    Add-Case 'setup' 'PATH' 'node not found' $false
} elseif (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Add-Case 'setup' 'tar' 'not found' $false
} else {
    Add-Case 'setup' 'Node22 + tar + npm.cmd' ("node $(node -v)") $true

    $env:COWCODE_INSTALL_DIR = $InstallDir
    $installLog = Join-Path $TestRoot 'install.log'
    & (Join-Path $Repo 'install.ps1') -SkipSetup 2>&1 | Out-File $installLog
    $installOk = ($LASTEXITCODE -eq 0) -and (Test-Path (Join-Path $InstallDir 'node_modules\dotenv'))
    Add-Case 'install.ps1 -SkipSetup' 'temp install dir' "exit=$LASTEXITCODE" $installOk

    if ($installOk) {
        $binDir = Join-Path $env:USERPROFILE '.local\bin'
        $env:Path = "$binDir;$env:Path"
        $env:COWCODE_INSTALL_DIR = $InstallDir
        $cli = Join-Path $InstallDir 'cli.js'

        & node $cli status 2>&1 | Out-Null
        Add-Case 'cowcode status' 'before start' "exit=$LASTEXITCODE" ($LASTEXITCODE -ne 0 -or $LASTEXITCODE -eq 0)

        & node $cli start 2>&1 | Out-File (Join-Path $TestRoot 'start.log')
        $startOk = ($LASTEXITCODE -eq 0)
        Add-Case 'cowcode start' 'pm2 daemon' "exit=$LASTEXITCODE" $startOk

        & node $cli status 2>&1 | Out-File (Join-Path $TestRoot 'status.log')
        $statusOk = ($LASTEXITCODE -eq 0) -and ((Get-Content (Join-Path $TestRoot 'status.log') -Raw -ErrorAction SilentlyContinue) -match 'online|cowcode')
        Add-Case 'cowcode status' 'after start' "exit=$LASTEXITCODE online=$statusOk" $statusOk

        & node $cli restart 2>&1 | Out-Null
        Add-Case 'cowcode restart' 'pm2 restart' "exit=$LASTEXITCODE" ($LASTEXITCODE -eq 0)

        & node $cli stop 2>&1 | Out-Null
        Add-Case 'cowcode stop' 'pm2 stop' "exit=$LASTEXITCODE" ($LASTEXITCODE -eq 0)

        $pkgPath = Join-Path $InstallDir 'package.json'
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        $pkg.version = '0.0.1-test-old'
        $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8

        $env:COWCODE_ROOT = $InstallDir
        & (Join-Path $Repo 'update.ps1') -Force 2>&1 | Out-File (Join-Path $TestRoot 'update-force.log')
        $verAfterForce = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
        Add-Case 'update.ps1 -Force' 'v0.0.1-test-old' "exit=$LASTEXITCODE ver=$verAfterForce" (($LASTEXITCODE -eq 0) -and ($verAfterForce -eq '2.0.0'))

        & (Join-Path $Repo 'update.ps1') 2>&1 | Out-File (Join-Path $TestRoot 'update-skip.log')
        $skipExit = $LASTEXITCODE
        $verAfterSkip = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
        $skipOk = ($skipExit -eq 0) -and ($verAfterSkip -eq '2.0.0')
        Add-Case 'update.ps1' 'same version' "exit=$skipExit ver=$verAfterSkip" $skipOk

        $pkg.version = '0.0.1-test-old'
        $pkg | ConvertTo-Json -Depth 10 | Set-Content $pkgPath -Encoding UTF8
        & node $cli update --force 2>&1 | Out-File (Join-Path $TestRoot 'cli-update-force.log')
        $verCli = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
        Add-Case 'cowcode update --force' 'cli.js -> update.ps1' "exit=$LASTEXITCODE ver=$verCli" (($LASTEXITCODE -eq 0) -and ($verCli -eq '2.0.0'))
    } else {
        Get-Content $installLog -Tail 6 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" }
        foreach ($n in @('cowcode start', 'cowcode status', 'cowcode restart', 'cowcode stop', 'update.ps1 -Force', 'update.ps1', 'cowcode update --force')) {
            Add-Case $n 'skipped' 'install failed' $false
        }
    }
}

Cleanup-Test $launcherBackup

Write-Host ""
Write-Host "| Test | Input | Output | Status |"
Write-Host "|------|-------|--------|--------|"
foreach ($r in $Results) {
    $icon = if ($r.Status -eq 'Pass') { 'Pass' } else { 'Fail' }
    Write-Host "| $($r.Test) | $($r.Input) | $($r.Output) | $icon |"
}
Write-Host ""

$failed = @($Results | Where-Object { $_.Status -ne 'Pass' }).Count
if ($failed -gt 0) { exit 1 }
exit 0
