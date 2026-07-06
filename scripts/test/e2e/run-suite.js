#!/usr/bin/env node
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

const REAL_TESTS = [
  ['agent', 'scripts/test/e2e/real/agent/test-agent.js'],
  ['agent-team-e2e', 'scripts/test/e2e/real/agent/test-agent-team-e2e.js'],
  ['casual-greetings-e2e', 'scripts/test/e2e/real/agent/test-casual-greetings.js'],
  ['basic-e2e', 'scripts/test/e2e/real/core/test-basic-e2e.js'],
  ['project-workflow-e2e', 'scripts/test/e2e/real/core/test-project-workflow-e2e.js'],
  ['dashboard-browser-e2e', 'scripts/test/e2e/real/dashboard/test-dashboard-browser-e2e.js'],
  ['apply-patch-e2e', 'scripts/test/e2e/real/skills/test-apply-patch-e2e.js'],
  ['browser-e2e', 'scripts/test/e2e/real/skills/test-browser-e2e.js'],
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
  ['weather-chat-fake-e2e', 'scripts/test/e2e/fake/test-weather-chat-e2e.js'],
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

function runOne(mode, name, script) {
  return new Promise((resolve) => {
    console.log(`@@@@@@ E2E_${mode.toUpperCase()}_START ${name} @@@@@@`);
    console.log(`@@@@@@ CMD node ${script} @@@@@@`);
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_E2E_MODE: mode },
      stdio: 'inherit',
    });
    child.on('close', (code) => {
      console.log(`@@@@@@ EXIT ${code ?? 0} @@@@@@`);
      console.log(`@@@@@@ E2E_${mode.toUpperCase()}_END ${name} @@@@@@`);
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      console.error(err?.stack || err?.message || String(err));
      console.log('@@@@@@ EXIT 1 @@@@@@');
      console.log(`@@@@@@ E2E_${mode.toUpperCase()}_END ${name} @@@@@@`);
      resolve(1);
    });
  });
}

async function runLane(mode, tests) {
  let failed = 0;
  for (const [name, script] of tests) {
    const code = await runOne(mode, name, script);
    if (code !== 0) failed += 1;
  }
  return failed;
}

async function main() {
  const mode = parseMode();
  let failed = 0;
  if (mode === 'real' || mode === 'all') {
    failed += await runLane('real', REAL_TESTS);
  }
  if (mode === 'fake' || mode === 'all') {
    failed += await runLane('fake', FAKE_TESTS);
  }
  if (failed) {
    console.error(`E2E suite failed: ${failed} test file(s) failed.`);
    process.exit(1);
  }
  console.log(`E2E ${mode} suite passed.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
