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
import { startReport, recordCase, endReport } from '../../support/e2e-report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const INSTALL_SH = join(ROOT, 'install.sh');
const UPDATE_SH = join(ROOT, 'update.sh');
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

function checkPastureLauncherNotLegacyShim() {
  const install = readFileSync(INSTALL_SH, 'utf8');
  const update = readFileSync(UPDATE_SH, 'utf8');
  const checks = [];

  for (const [label, src] of [['install.sh', install], ['update.sh', update]]) {
    if (!src.includes('cat > "$BIN_DIR/pasture" <<LAUNCHER')) {
      checks.push(`${label} must write the primary pasture launcher`);
    }
    if (!src.includes('exec node')) {
      checks.push(`${label} pasture launcher must exec node cli.js`);
    }
    const legacyName = 'cow' + 'code';
    if (src.includes(legacyName)) {
      checks.push(`${label} must not reference the legacy name (${legacyName})`);
    }
  }

  if (checks.length) return { ok: false, detail: checks.join('; ') };
  return { ok: true, detail: 'pasture launcher is the sole CLI entry point; no legacy name references' };
}

function checkCliSetupCommand() {
  const cli = readFileSync(join(ROOT, 'cli.js'), 'utf8');
  const checks = [];
  if (!cli.includes("sub === 'setup'")) {
    checks.push("cli.js must handle sub === 'setup'");
  }
  if (!cli.includes('setup.js')) {
    checks.push('cli.js setup must spawn setup.js');
  }
  if (!cli.includes('pasture setup')) {
    checks.push('cli.js help must list pasture setup');
  }
  if (checks.length) return { ok: false, detail: checks.join('; ') };
  return { ok: true, detail: 'pasture setup runs setup.js with PASTURE_INSTALL_DIR' };
}

function checkSetupCloudSelectionSetsPriority() {
  const src = readFileSync(SETUP_JS, 'utf8');
  const start = src.indexOf('function saveCloudLlmSelection');
  const end = src.indexOf('\nfunction ', start + 1);
  const body = start >= 0 ? src.slice(start, end >= 0 ? end : undefined) : '';
  const checks = [];

  if (!body.includes('models[i].priority = true')) {
    checks.push('chosen cloud provider must become priority');
  }
  if (!body.includes("delete models[i].priority")) {
    checks.push('previous priority flags must be cleared');
  }
  if (body.includes('hasPriorityAlready')) {
    checks.push('setup must not preserve an existing local/cloud priority after provider selection');
  }
  if (!body.includes('models[i].model = selectedModel')) {
    checks.push('selected cloud model must be saved');
  }
  if (!src.includes("if ((llm1Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel)")) {
    checks.push('OpenAI priority should be saved only after a key exists');
  }
  if (!src.includes("if ((llm2Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel)")) {
    checks.push('Grok priority should be saved only after a key exists');
  }
  if (!src.includes("if ((llm3Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel)")) {
    checks.push('Anthropic priority should be saved only after a key exists');
  }

  if (checks.length) return { ok: false, detail: checks.join('; ') };
  return { ok: true, detail: 'pasture setup makes the selected cloud provider the LLM priority' };
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

  const launcher = checkPastureLauncherNotLegacyShim();
  recordCase({
    name: 'pasture launcher',
    input: 'install/update launcher scripts',
    output: launcher.detail,
    status: launcher.ok ? 'pass' : 'fail',
  });

  const setupCmd = checkCliSetupCommand();
  recordCase({
    name: 'pasture setup command',
    input: 'pasture setup',
    output: setupCmd.detail,
    status: setupCmd.ok ? 'pass' : 'fail',
  });

  const cloudPriority = checkSetupCloudSelectionSetsPriority();
  recordCase({
    name: 'setup cloud priority',
    input: 'select OpenAI/Grok/Anthropic during setup',
    output: cloudPriority.detail,
    status: cloudPriority.ok ? 'pass' : 'fail',
  });

  const shellTest = spawnSync('bash', [join(ROOT, 'scripts/test/unit/core/test-install.sh')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const shellOut = (shellTest.stdout || '') + (shellTest.stderr || '');
  const bashMissing = shellTest.error?.code === 'ENOENT';
  const shellOk = bashMissing || (shellTest.status === 0 && shellOut.includes('INSTALL_OK'));
  recordCase({
    name: 'test-install.sh',
    input: 'bash install.sh -c which pasture',
    output: bashMissing ? 'SKIP: bash not available on this host' : shellOk ? 'INSTALL_OK' : shellOut.trim().slice(-300),
    status: shellOk ? 'pass' : 'fail',
  });

  endReport();
  process.exit(order.ok && imports.ok && unix.ok && launcher.ok && setupCmd.ok && cloudPriority.ok && shellOk ? 0 : 1);
}

main();
