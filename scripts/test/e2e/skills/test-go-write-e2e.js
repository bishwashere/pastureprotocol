/**
 * E2E tests for the go-write skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → go-write skill → reply → judge.
 * Uses shared state: first test creates a file, second test copies it.
 */

import { spawn } from 'child_process';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { runSkillTests } from '../../support/skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from '../../support/e2e-judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-go-write-e2e-' + Date.now());
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
  console.log('E2E tests: go-write skill (user message → LLM → go-write → reply → judge).');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = createTempStateDir();

  const tests = [
    {
      name: 'go-write: create empty file',
      expectMode: 'actual',
      skill: 'go-write',
      stateDir,
      actualChecks: { fileExists: 'workspace/e2e-touch.txt' },
      run: async () => {
        const query = 'Create an empty file named e2e-touch.txt in the workspace.';
        const result = await runE2E(query, { stateDir });
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'go-write' });
        if (!pass) {
          const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled, stateDir };
      },
    },
    {
      name: 'go-write: copy file',
      expectMode: 'behavior',
      run: async () => {
        const query = 'Copy e2e-touch.txt to e2e-copy.txt in the workspace.';
        const result = await runE2E(query, { stateDir });
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'go-write' });
        if (!pass) {
          const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
  ];

  const { failed } = await runSkillTests('go-write', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
