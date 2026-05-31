#!/usr/bin/env node
/**
 * Regression tests for fresh install:
 * 1. install.sh must install node_modules before setup.js (dotenv and other deps required).
 * 2. setup.js must not top-level-import tide-checklist.js (pulls dotenv before ensureInstall).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { startReport, recordCase, endReport } from './e2e-report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const INSTALL_SH = join(ROOT, 'install.sh');
const SETUP_JS = join(ROOT, 'setup.js');

function checkInstallScriptOrder() {
  const script = readFileSync(INSTALL_SH, 'utf8');
  const depsIdx = script.indexOf('install_deps');
  const setupIdx = script.indexOf('node setup.js');
  if (depsIdx < 0 || setupIdx < 0) {
    return { ok: false, detail: 'install_deps or node setup.js not found in install.sh' };
  }
  if (depsIdx > setupIdx) {
    return { ok: false, detail: 'install_deps runs after setup.js — fresh install will crash on missing dotenv' };
  }
  return { ok: true, detail: 'install_deps runs before setup.js' };
}


function checkSetupMinimalTopLevelImports() {
  const src = readFileSync(SETUP_JS, 'utf8');
  const imports = [...src.matchAll(/^import\s+.*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const allowed = new Set([
    'fs',
    'path',
    'url',
    'readline',
    'child_process',
    './lib/paths.js',
  ]);
  const unexpected = imports.filter((i) => !allowed.has(i) && !i.startsWith('node:'));
  if (unexpected.length) {
    return {
      ok: false,
      detail: `setup.js top-level imports require node_modules before ensureInstall: ${unexpected.join(', ')}`,
    };
  }
  return { ok: true, detail: 'setup.js only imports stdlib + paths.js at load time' };
}

function checkUnixPathsUnchanged() {
  const cli = readFileSync(join(ROOT, 'cli.js'), 'utf8');
  const sh = readFileSync(INSTALL_SH, 'utf8');
  const checks = [];

  if (!cli.includes("spawn('bash', [script, action]")) {
    checks.push('cli.js must still spawn bash daemon.sh on Linux/macOS');
  }
  if (!cli.includes("spawn('bash', [script]") || !cli.includes('update.sh')) {
    checks.push('cli.js must still use bash update.sh on Linux/macOS');
  }
  if (!cli.includes("spawn('bash', [script]") || !cli.includes('uninstall.sh')) {
    checks.push('cli.js must still use bash uninstall.sh on Linux/macOS');
  }
  if (!cli.includes('if (IS_WIN)')) {
    checks.push('cli.js must gate Windows-only paths behind IS_WIN');
  }
  if (sh.includes('install.ps1')) {
    checks.push('install.sh must not reference install.ps1');
  }
  if (sh.indexOf('install_deps') > sh.indexOf('node setup.js')) {
    checks.push('install.sh must run install_deps before setup.js');
  }
  if (!existsSync(join(ROOT, 'scripts', 'daemon.sh'))) {
    checks.push('scripts/daemon.sh missing');
  }

  if (checks.length) {
    return { ok: false, detail: checks.join('; ') };
  }
  return { ok: true, detail: 'Linux/macOS still use install.sh + bash daemon/update/uninstall' };
}

async function main() {
  startReport('test-install');

  const order = checkInstallScriptOrder();
  recordCase({
    name: 'install.sh order',
    input: 'install_deps before setup.js',
    output: order.detail,
    status: order.ok ? 'pass' : 'fail',
  });

  const imports = checkSetupMinimalTopLevelImports();
  recordCase({
    name: 'setup.js imports',
    input: 'stdlib + paths.js only at load time',
    output: imports.detail,
    status: imports.ok ? 'pass' : 'fail',
  });

  const unix = checkUnixPathsUnchanged();
  recordCase({
    name: 'unix paths',
    input: 'Linux/macOS install + daemon unchanged',
    output: unix.detail,
    status: unix.ok ? 'pass' : 'fail',
  });

  const shellTest = spawnSync('bash', [join(ROOT, 'scripts/test/test-install.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shellOut = (shellTest.stdout || '') + (shellTest.stderr || '');
  const shellOk = shellTest.status === 0 && shellOut.includes('INSTALL_OK');
  recordCase({
    name: 'test-install.sh',
    input: 'bash install.sh -c which cowcode',
    output: shellOk ? 'INSTALL_OK' : shellOut.trim().slice(-300),
    status: shellOk ? 'pass' : 'fail',
  });

  endReport();
  process.exit(order.ok && imports.ok && unix.ok && shellOk ? 0 : 1);
}

main();
