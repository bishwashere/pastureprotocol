/**
 * E2E tests for the speech skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → speech skill → reply → judge.
 * Covers synthesize and reply_as_voice (no audio file for transcribe in --test).
 */

import { spawn } from 'child_process';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

const SPEECH_QUERIES = [
  'Can you say this out loud: Hello from E2E speech test?',
  'Send me a voice note that says E2E speech test OK.',
];

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-speech-e2e-' + Date.now());
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  return stateDir;
}

function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js', '--test', userMessage], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`E2E run timed out after ${PER_TEST_TIMEOUT_MS / 1000}s`));
    }, PER_TEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const startIdx = stdout.indexOf(E2E_REPLY_MARKER_START);
      const endIdx = stdout.indexOf(E2E_REPLY_MARKER_END);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        reject(new Error(`No E2E reply (code ${code}). stderr: ${stderr.slice(-500)}`));
        return;
      }
      const reply = stdout
        .slice(startIdx + E2E_REPLY_MARKER_START.length, endIdx)
        .replace(/^\n+|\n+$/g, '')
        .trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${reply.slice(0, 200)}`));
        return;
      }
      resolve({ reply, skillsCalled });
    });
  });
}

async function main() {
  console.log('E2E tests: speech skill (user message → LLM → speech → reply → judge).');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = createTempStateDir();

  const tests = SPEECH_QUERIES.map((query, i) => ({
    name: `speech: "${query.slice(0, 50)}…"`,
    expectMode: i === 0 ? 'actual' : 'behavior',
    skill: i === 0 ? 'speech' : undefined,
    run: async () => {
      const result = await runE2E(query, { stateDir });
      const reply = result.reply ?? result;
      const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'speech' });
      if (!pass) {
        const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
        err.reply = reply;
        err.skillsCalled = result.skillsCalled;
        throw err;
      }
      return { reply, skillsCalled: result.skillsCalled, stateDir };
    },
  }));

  const { failed } = await runSkillTests('speech', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
