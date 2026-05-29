/**
 * E2E tests for the go-read skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → go-read skill → reply → judge.
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
const DEFAULT_STATE_DIR = process.env.COWCODE_STATE_DIR || join(homedir(), '.cowcode');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

const GO_READ_QUERIES = [
  'List the files in the workspace directory.',
  'What is the current working directory? Use go-read to run pwd.',
  'Show me the contents of config.json in the workspace using cat.',
];

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'cowcode-go-read-e2e-' + Date.now());
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(workspaceDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  return stateDir;
}

function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.COWCODE_STATE_DIR = opts.stateDir;
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
  console.log('E2E tests: go-read skill (user message → LLM → go-read → reply → judge).');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = createTempStateDir();

  const tests = GO_READ_QUERIES.map((query, i) => ({
    name: `go-read: "${query.slice(0, 50)}…"`,
    expectMode: i === 0 ? 'actual' : 'behavior',
    skill: i === 0 ? 'go-read' : undefined,
    run: async () => {
      const result = await runE2E(query, { stateDir });
      const reply = result.reply ?? result;
      const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'go-read' });
      if (!pass) {
        const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
        err.reply = reply;
        err.skillsCalled = result.skillsCalled;
        throw err;
      }
      return { reply, skillsCalled: result.skillsCalled, stateDir };
    },
  }));

  const { failed } = await runSkillTests('go-read', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
