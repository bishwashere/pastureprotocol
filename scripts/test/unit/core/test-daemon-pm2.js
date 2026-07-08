#!/usr/bin/env node
/**
 * Unit tests for lib/daemon-pm2.js (Windows daemon without bash).
 */

import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { runPm2DaemonAction, daemonLog, ensurePm2 } from '../../../../lib/util/daemon-pm2.js';
import { getCurrentDaemonErrPath, getCurrentDaemonLogPath, getDailyDaemonLogPath } from '../../../../lib/util/daemon-log-path.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cases = [];

function startReport(name) {
  console.log(`\n${name}`);
}

function recordCase(row) {
  cases.push(row);
  const mark = row.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${row.name}: ${row.output}`);
}

function endReport() {
  const passed = cases.filter((c) => c.status === 'pass').length;
  const failed = cases.length - passed;
  console.log(`\n[daemon-pm2] passed=${passed} failed=${failed}`);
}

function checkCliUsesPm2OnWindows() {
  const src = readFileSync(join(ROOT, 'cli.js'), 'utf8');
  if (!src.includes("from './lib/util/daemon-pm2.js'")) {
    return { ok: false, detail: 'cli.js does not import daemon-pm2.js' };
  }
  if (!src.includes('runPm2DaemonAction') || !src.includes('IS_WIN')) {
    return { ok: false, detail: 'cli.js missing win32 pm2 daemon routing' };
  }
  if (!src.includes('update.ps1') || !src.includes('runWindowsUninstall')) {
    return { ok: false, detail: 'cli.js missing native Windows update/uninstall' };
  }
  const uninstallIdx = src.indexOf("sub === 'uninstall'");
  const windowsUninstallIdx = src.indexOf('runWindowsUninstall', uninstallIdx);
  const shellUninstallIdx = src.indexOf('uninstall.sh', uninstallIdx);
  if (uninstallIdx < 0 || windowsUninstallIdx < uninstallIdx || shellUninstallIdx < uninstallIdx || windowsUninstallIdx > shellUninstallIdx) {
    return { ok: false, detail: 'cli.js must run native Windows uninstall before the bash uninstall.sh path' };
  }
  return { ok: true, detail: 'cli.js routes win32 start/stop/update/uninstall without bash' };
}

function checkWindowsPs1(filename, opts) {
  const path = join(ROOT, filename);
  let src;
  try {
    src = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, detail: `${filename} missing` };
  }
  if (/[^\x09\x0A\x0D\x20-\x7E]/.test(src)) {
    return { ok: false, detail: `${filename} must be ASCII-only (PowerShell 5.1)` };
  }
  if (src.includes('$ErrorActionPreference = "Stop"')) {
    return { ok: false, detail: `${filename} must not use Stop (breaks npm/tar on PS 5.1)` };
  }
  const required = [
    'Encode-GitHubBranchPath',
    'Get-PastureRequestHeaders',
    'Save-PastureDownload',
    'Read-PackageJsonVersion',
    'ConvertFrom-Json',
    'Cache-Control',
    'User-Agent',
  ];
  for (const token of required) {
    if (!src.includes(token)) {
      return { ok: false, detail: `${filename} missing ${token}` };
    }
  }
  if (/ForEach-Object\s*\{[^}]+\}\s*-join/.test(src)) {
    return { ok: false, detail: `${filename} must not pipe ForEach-Object to -join (PS 5.1 binds -join to ForEach-Object)` };
  }
  if (opts.depsBeforeSetup) {
    const depsIdx = src.indexOf('Installing dependencies');
    const setupIdx = src.indexOf('node setup.js');
    if (depsIdx < 0 || setupIdx < 0 || depsIdx > setupIdx) {
      return { ok: false, detail: `${filename} must install dependencies before setup.js` };
    }
  }
  if (opts.launcher && !src.includes('pasture.cmd')) {
    return { ok: false, detail: `${filename} must create pasture.cmd launcher` };
  }
  if (opts.exitHelper && !src.includes(opts.exitHelper)) {
    return { ok: false, detail: `${filename} must define ${opts.exitHelper}` };
  }
  if (opts.offerNode && !src.includes('Offer-PastureNodeJs')) {
    return { ok: false, detail: `${filename} must offer Node.js install help` };
  }
  if (opts.pm2Help && !src.includes('Ensure-PasturePm2')) {
    return { ok: false, detail: `${filename} must offer pm2 install help` };
  }
  if (opts.pm2Help && !src.includes('Show-PasturePostInstallHelp')) {
    return { ok: false, detail: `${filename} must show post-install commands` };
  }
  if (opts.pm2Help && !src.includes('Enable-PasturePm2AutoRestart')) {
    return { ok: false, detail: `${filename} must configure pm2 auto-start` };
  }
  if (opts.npmCmd && !src.includes('Get-PastureToolPath')) {
    return { ok: false, detail: `${filename} must use npm.cmd (execution policy safe)` };
  }
  if (opts.npmCmd && !src.includes('Test-PastureSupportedNode')) {
    return { ok: false, detail: `${filename} must reject unsupported Node versions` };
  }
  if (opts.pastureRepo && !src.includes('bishwashere/pastureprotocol')) {
    return { ok: false, detail: `${filename} must download from pastureprotocol repo` };
  }
  if (opts.pastureRepo && !src.includes('Archive extract failed (no top-level folder)')) {
    return { ok: false, detail: `${filename} must validate extracted archive root` };
  }
  if (opts.pastureRepo && src.includes('bishwashere/Pasture')) {
    return { ok: false, detail: `${filename} must not download from legacy Pasture repo` };
  }
  return { ok: true, detail: `${filename} hardened for PS 5.1` };
}

function checkInstallPs1() {
  return checkWindowsPs1('install.ps1', {
    depsBeforeSetup: true,
    launcher: true,
    exitHelper: 'Exit-Install',
    offerNode: true,
    pm2Help: true,
    npmCmd: true,
    pastureRepo: true,
  });
}

function checkUpdatePs1() {
  return checkWindowsPs1('update.ps1', {
    exitHelper: 'Exit-Update',
    npmCmd: true,
    pastureRepo: true,
  });
}

function checkDaemonLog() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-daemon-log-'));
  try {
    daemonLog(dir, 'test');
    const content = readFileSync(getDailyDaemonLogPath(dir), 'utf8');
    if (!content.includes('pasture test')) {
      return { ok: false, detail: 'daemonLog did not write expected line' };
    }
    if (!existsSync(getCurrentDaemonLogPath(dir))) {
      return { ok: false, detail: 'current.log was not created' };
    }
    if (!existsSync(getCurrentDaemonErrPath(dir))) {
      return { ok: false, detail: 'current.err was not created' };
    }
    return { ok: true, detail: 'daemonLog writes daily control lines' };
  } catch (e) {
    return { ok: false, detail: e.message };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function checkWindowsPm2Quoting() {
  const src = readFileSync(join(ROOT, 'lib', 'util', 'daemon-pm2.js'), 'utf8');
  if (!src.includes('quoteWindowsShellArg')) {
    return { ok: false, detail: 'missing Windows shell argument quoting helper' };
  }
  if (!src.includes('pm2ShellArgs(args)')) {
    return { ok: false, detail: 'pm2Args must route args through Windows shell quoting' };
  }
  if (!src.includes('dailyLogPath') || !src.includes("'--output'")) {
    return { ok: false, detail: 'pm2 start must include daily output/error log paths' };
  }
  return { ok: true, detail: 'pm2 args preserve Windows paths with spaces' };
}

function checkMissingInstallDir() {
  const code = runPm2DaemonAction('start', { installDir: join(ROOT, 'nonexistent-install-dir') });
  if (code === 0) {
    return { ok: false, detail: 'expected non-zero exit for missing index.js' };
  }
  return { ok: true, detail: `exit ${code} when install dir missing` };
}

async function main() {
  startReport('test-daemon-pm2');

  const cli = checkCliUsesPm2OnWindows();
  recordCase({ name: 'cli.js win32', input: 'pm2 routing', output: cli.detail, status: cli.ok ? 'pass' : 'fail' });

  const ps1 = checkInstallPs1();
  recordCase({ name: 'install.ps1', input: 'headers/json/errors', output: ps1.detail, status: ps1.ok ? 'pass' : 'fail' });

  const upd = checkUpdatePs1();
  recordCase({ name: 'update.ps1', input: 'headers/json/errors', output: upd.detail, status: upd.ok ? 'pass' : 'fail' });

  const log = checkDaemonLog();
  recordCase({ name: 'daemonLog', input: 'write line', output: log.detail, status: log.ok ? 'pass' : 'fail' });

  const quoting = checkWindowsPm2Quoting();
  recordCase({ name: 'pm2 quoting', input: 'paths with spaces', output: quoting.detail, status: quoting.ok ? 'pass' : 'fail' });

  const missing = checkMissingInstallDir();
  recordCase({ name: 'runPm2DaemonAction', input: 'missing install dir', output: missing.detail, status: missing.ok ? 'pass' : 'fail' });

  // ensurePm2 is environment-dependent; only verify it is a function
  const fnOk = typeof ensurePm2 === 'function' && typeof runPm2DaemonAction === 'function';
  recordCase({
    name: 'exports',
    input: 'ensurePm2 + runPm2DaemonAction',
    output: fnOk ? 'functions exported' : 'missing exports',
    status: fnOk ? 'pass' : 'fail',
  });

  endReport();
  process.exit(cli.ok && ps1.ok && upd.ok && log.ok && quoting.ok && missing.ok && fnOk ? 0 : 1);
}

main();
