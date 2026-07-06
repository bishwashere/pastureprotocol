#!/usr/bin/env node
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const LIVE_LOG_PATH = process.env.PASTURE_DAEMON_LOG_PATH || join(homedir(), '.pasture', 'daemon.log');

const REAL_TESTS = [
  ['agent', 'scripts/test/e2e/real/agent/test-agent.js'],
  ['agent-send', 'scripts/test/e2e/real/agent/test-agent-send.js'],
  ['agent-team-e2e', 'scripts/test/e2e/real/agent/test-agent-team-e2e.js'],
  ['agent-title', 'scripts/test/e2e/real/agent/test-agent-title.js'],
  ['casual-greetings-e2e', 'scripts/test/e2e/real/agent/test-casual-greetings.js'],
  ['basic-e2e', 'scripts/test/e2e/real/core/test-basic-e2e.js'],
  ['project-workflow-e2e', 'scripts/test/e2e/real/core/test-project-workflow-e2e.js'],
  ['dashboard-browser-e2e', 'scripts/test/e2e/real/dashboard/test-dashboard-browser-e2e.js'],
  ['apply-patch-e2e', 'scripts/test/e2e/real/skills/test-apply-patch-e2e.js'],
  ['browser-e2e', 'scripts/test/e2e/real/skills/test-browser-e2e.js'],
  ['browser', 'scripts/test/e2e/real/skills/test-browser.js'],
  ['core-e2e', 'scripts/test/e2e/real/skills/test-core-e2e.js'],
  ['cron-e2e', 'scripts/test/e2e/real/skills/test-cron-e2e.js'],
  ['edit-e2e', 'scripts/test/e2e/real/skills/test-edit-e2e.js'],
  ['go-read-e2e', 'scripts/test/e2e/real/skills/test-go-read-e2e.js'],
  ['go-write-e2e', 'scripts/test/e2e/real/skills/test-go-write-e2e.js'],
  ['gog-e2e', 'scripts/test/e2e/real/skills/test-gog-e2e.js'],
  ['home-assistant-e2e', 'scripts/test/e2e/real/skills/test-home-assistant-e2e.js'],
  ['me-e2e', 'scripts/test/e2e/real/skills/test-me-e2e.js'],
  ['memory-e2e', 'scripts/test/e2e/real/skills/test-memory-e2e.js'],
  ['read-e2e', 'scripts/test/e2e/real/skills/test-read-e2e.js'],
  ['search-e2e', 'scripts/test/e2e/real/skills/test-search-e2e.js'],
  ['server-inspect-e2e', 'scripts/test/e2e/real/skills/test-server-inspect-e2e.js'],
  ['speech-e2e', 'scripts/test/e2e/real/skills/test-speech-e2e.js'],
  ['vision-e2e', 'scripts/test/e2e/real/skills/test-vision-e2e.js'],
  ['write-e2e', 'scripts/test/e2e/real/skills/test-write-e2e.js'],
  ['live-log-conversation-real', 'scripts/test/e2e/real/test-live-log-conversation.js'],
];

const FAKE_TESTS = [
  ['agent', 'scripts/test/e2e/fake/agent/test-agent.js'],
  ['agent-send', 'scripts/test/e2e/fake/agent/test-agent-send.js'],
  ['agent-team-e2e', 'scripts/test/e2e/fake/agent/test-agent-team-e2e.js'],
  ['agent-title', 'scripts/test/e2e/fake/agent/test-agent-title.js'],
  ['casual-greetings-e2e', 'scripts/test/e2e/fake/agent/test-casual-greetings.js'],
  ['basic-e2e', 'scripts/test/e2e/fake/core/test-basic-e2e.js'],
  ['project-workflow-e2e', 'scripts/test/e2e/fake/core/test-project-workflow-e2e.js'],
  ['dashboard-browser-e2e', 'scripts/test/e2e/fake/dashboard/test-dashboard-browser-e2e.js'],
  ['apply-patch-e2e', 'scripts/test/e2e/fake/skills/test-apply-patch-e2e.js'],
  ['browser-e2e', 'scripts/test/e2e/fake/skills/test-browser-e2e.js'],
  ['browser', 'scripts/test/e2e/fake/skills/test-browser.js'],
  ['core-e2e', 'scripts/test/e2e/fake/skills/test-core-e2e.js'],
  ['cron-e2e', 'scripts/test/e2e/fake/skills/test-cron-e2e.js'],
  ['edit-e2e', 'scripts/test/e2e/fake/skills/test-edit-e2e.js'],
  ['go-read-e2e', 'scripts/test/e2e/fake/skills/test-go-read-e2e.js'],
  ['go-write-e2e', 'scripts/test/e2e/fake/skills/test-go-write-e2e.js'],
  ['gog-e2e', 'scripts/test/e2e/fake/skills/test-gog-e2e.js'],
  ['home-assistant-e2e', 'scripts/test/e2e/fake/skills/test-home-assistant-e2e.js'],
  ['me-e2e', 'scripts/test/e2e/fake/skills/test-me-e2e.js'],
  ['memory-e2e', 'scripts/test/e2e/fake/skills/test-memory-e2e.js'],
  ['read-e2e', 'scripts/test/e2e/fake/skills/test-read-e2e.js'],
  ['search-e2e', 'scripts/test/e2e/fake/skills/test-search-e2e.js'],
  ['server-inspect-e2e', 'scripts/test/e2e/fake/skills/test-server-inspect-e2e.js'],
  ['speech-e2e', 'scripts/test/e2e/fake/skills/test-speech-e2e.js'],
  ['vision-e2e', 'scripts/test/e2e/fake/skills/test-vision-e2e.js'],
  ['write-e2e', 'scripts/test/e2e/fake/skills/test-write-e2e.js'],
  ['live-log-conversation-fake', 'scripts/test/e2e/fake/test-live-log-conversation.js'],
];

function parseMode() {
  if (process.argv.includes('--fake')) return 'fake';
  if (process.argv.includes('--real')) return 'real';
  if (process.argv.includes('--all')) return 'all';
  const modeArg = process.argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg ? modeArg.slice('--mode='.length) : '';
  if (mode === 'fake' || mode === 'real' || mode === 'all') return mode;
  return 'real';
}

function parseOnly() {
  const index = process.argv.indexOf('--only');
  if (index >= 0) return process.argv[index + 1] || '';
  const arg = process.argv.find((value) => value.startsWith('--only='));
  return arg ? arg.slice('--only='.length) : '';
}

function timestamp() {
  return new Date().toISOString().slice(0, 19);
}

function appendLiveLog(chunk) {
  try {
    mkdirSync(dirname(LIVE_LOG_PATH), { recursive: true });
    appendFileSync(LIVE_LOG_PATH, chunk, 'utf8');
  } catch (_) {
    // Test output must still stream even if the user's daemon log is not writable.
  }
}

function logSuite(line) {
  console.log(line);
  appendLiveLog(`[${timestamp()}] [E2E] ${line}\n`);
}

function runOne(mode, name, script) {
  return new Promise((resolve) => {
    logSuite(`@@@@@@ E2E_${mode.toUpperCase()}_START ${name} @@@@@@`);
    logSuite(`@@@@@@ CMD node ${script} @@@@@@`);
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: {
        ...process.env,
        PASTURE_E2E_MODE: mode,
        PASTURE_E2E_LIVE_LOG: '1',
        PASTURE_DAEMON_LOG_PATH: LIVE_LOG_PATH,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      appendLiveLog(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      appendLiveLog(chunk);
    });
    child.on('close', (code) => {
      logSuite(`@@@@@@ EXIT ${code ?? 0} @@@@@@`);
      logSuite(`@@@@@@ E2E_${mode.toUpperCase()}_END ${name} @@@@@@`);
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      console.error(err?.stack || err?.message || String(err));
      appendLiveLog(`${err?.stack || err?.message || String(err)}\n`);
      logSuite('@@@@@@ EXIT 1 @@@@@@');
      logSuite(`@@@@@@ E2E_${mode.toUpperCase()}_END ${name} @@@@@@`);
      resolve(1);
    });
  });
}

async function runLane(mode, tests, only = '') {
  let failed = 0;
  const selected = only ? tests.filter(([name]) => name === only) : tests;
  if (only && selected.length === 0) {
    console.error(`No ${mode} E2E test named "${only}".`);
    return 1;
  }
  for (const [name, script] of selected) {
    const code = await runOne(mode, name, script);
    if (code !== 0) failed += 1;
  }
  return failed;
}

async function main() {
  const mode = parseMode();
  const only = parseOnly();
  let failed = 0;
  if (mode === 'real' || mode === 'all') {
    failed += await runLane('real', REAL_TESTS, only);
  }
  if (mode === 'fake' || mode === 'all') {
    failed += await runLane('fake', FAKE_TESTS, only);
  }
  if (failed) {
    console.error(`E2E suite failed: ${failed} test file(s) failed.`);
    appendLiveLog(`[${timestamp()}] [E2E] E2E suite failed: ${failed} test file(s) failed.\n`);
    process.exit(1);
  }
  logSuite(`E2E ${mode} suite passed.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
