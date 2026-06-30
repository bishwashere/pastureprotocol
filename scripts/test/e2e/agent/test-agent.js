/**
 * Dumb test. Only three things:
 * 1. Send the message to the agent.
 * 2. Print what it got back.
 * 3. End.
 *
 * No extra tools. No memory injection. No pre-filled history. No system prompt hacks.
 * The agent runs on its own prompt, its own skills, its own memory.
 *
 * Uses a temp state dir (workspace/.pasture-test) so cron can write without EPERM.
 * Memory scenario skipped by default (needs embeddings); run with TEST_MESSAGE="Search my memory..." to test.
 *
 * Usage:
 *   node scripts/test/test-agent.js              — run all scenarios
 *   node scripts/test/test-agent.js "one message" — run single message
 *   TEST_MESSAGE="..." node scripts/test/test-agent.js — run single message
 */

import { spawnSync } from 'child_process';
import { mkdirSync, copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..', '..', '..', '..');
const defaultStateDir = join(homedir(), '.pasture');
const testStateDir = join(root, '.pasture-test');

const SCENARIOS = [
  { name: 'cron add (clear)', message: 'Remind me to call Bishwas tomorrow at 5:30 p.m.' },
  { name: 'cron list', message: 'List my reminders' },
  { name: 'cron unclear (blue moon)', message: 'Remind me next week on the blue moon' },
  { name: 'search (time)', message: "What's the current time?" },
  { name: 'search (weather)', message: 'Weather in Tokyo' },
  { name: 'chat', message: 'Hello, what is 2+2?' },
];

function ensureTestStateDir() {
  if (!existsSync(testStateDir)) mkdirSync(testStateDir, { recursive: true });
  const cronDir = join(testStateDir, 'cron');
  if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
  const srcConfig = join(defaultStateDir, 'config.json');
  const srcEnv = join(defaultStateDir, '.env');
  if (existsSync(srcConfig)) copyFileSync(srcConfig, join(testStateDir, 'config.json'));
  if (existsSync(srcEnv)) copyFileSync(srcEnv, join(testStateDir, '.env'));
}

function runOne(message) {
  ensureTestStateDir();
  const env = { ...process.env, PASTURE_STATE_DIR: testStateDir };
  const result = spawnSync(process.execPath, ['index.js', '--test', message], {
    encoding: 'utf8',
    cwd: root,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const out = result.stdout || '';
  // Capture reply between markers (allow multiline)
  const match = out.match(/E2E_REPLY_START\s*\n([\s\S]*)\nE2E_REPLY_END/);
  const reply = match ? match[1].trim() : (out.trim() || '(no reply or markers not found)');
  return { status: result.status, reply, stderr: result.stderr || '' };
}

function main() {
  const single = process.argv[2] || process.env.TEST_MESSAGE;
  const runs = single ? [{ name: 'single', message: single }] : SCENARIOS;

  let failed = 0;
  for (const { name, message } of runs) {
    console.log('\n' + '─'.repeat(60));
    console.log('Scenario:', name);
    console.log('Message:', message.slice(0, 60) + (message.length > 60 ? '…' : ''));
    console.log('─'.repeat(60));
    const { status, reply, stderr } = runOne(message);
    console.log('Reply:', reply || '(empty)');
    if (stderr.trim()) console.log('Logs:', stderr.trim().split('\n').slice(-3).join(' '));
    if (status !== 0) failed++;
  }

  console.log('\n' + '─'.repeat(60));
  console.log('Done. Scenarios:', runs.length, 'Failed:', failed);
  process.exit(failed > 0 ? 1 : 0);
}

main();
