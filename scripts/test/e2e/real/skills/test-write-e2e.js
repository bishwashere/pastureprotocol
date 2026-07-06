/**
 * E2E tests for the write skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → write skill → reply → judge.
 * Uses fixed fixture state (fixtures/state) so the workspace has baseline data.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runSkillTests } from '../../../support/skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from '../../../support/e2e-judge.js';
import { prepareStateFromFixture } from '../../../support/test-fixture-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

const WRITE_QUERIES = [
  'Save a file called e2e-hello.txt with the text Hello from write E2E',
  'Create notes.md with a heading # Test notes and a second line that says Line two.',
  'Put the text saved by E2E into a file named e2e-saved.txt',
];

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
  console.log('E2E tests: write skill (user message → LLM → write → reply → judge).');
  console.log('Using fixed fixture state. Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = prepareStateFromFixture();

  const tests = WRITE_QUERIES.map((query, i) => ({
    name: `write: "${query.slice(0, 50)}…"`,
    expectMode: i === 0 ? 'actual' : 'behavior',
    skill: i === 0 ? 'write' : undefined,
    stateDir,
    actualChecks:
      i === 0
        ? {
            fileExists: 'workspace/e2e-hello.txt',
            fileContains: { path: 'workspace/e2e-hello.txt', text: 'Hello from write E2E' },
          }
        : undefined,
    run: async () => {
      const result = await runE2E(query, { stateDir });
      const reply = result.reply ?? result;
      const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'write' });
      if (!pass) {
        const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
        err.reply = reply;
        err.skillsCalled = result.skillsCalled;
        throw err;
      }
      return { reply, skillsCalled: result.skillsCalled, stateDir };
    },
  }));

  const { failed } = await runSkillTests('write', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
