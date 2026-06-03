/**
 * E2E tests for the edit skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → edit skill → reply → judge.
 * Uses fixed fixture state (fixtures/state) which includes workspace/e2e-edit-target.txt.
 */

import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { prepareStateFromFixture } from './test-fixture-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

const EDIT_TARGET_FILE = 'e2e-edit-target.txt';
const EDIT_INITIAL_CONTENT = 'Hello world\nEdit this line for E2E.\n';

const EDIT_QUERIES = [
  `In ${EDIT_TARGET_FILE} replace Hello with Hi`,
  `In the file ${EDIT_TARGET_FILE} change world to planet`,
  `In ${EDIT_TARGET_FILE}, replace "Edit this line" with "Edited line"`,
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
  console.log('E2E tests: edit skill (user message → LLM → edit → reply → judge).');
  console.log('Using fixed fixture state; target file:', EDIT_TARGET_FILE, '. Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = prepareStateFromFixture();
  const workspaceDir = join(stateDir, 'workspace');
  const targetPath = join(workspaceDir, EDIT_TARGET_FILE);

  function resetEditTarget() {
    writeFileSync(targetPath, EDIT_INITIAL_CONTENT, 'utf8');
  }

  const tests = EDIT_QUERIES.map((query, index) => ({
    name: `edit: "${query.slice(0, 45)}…"`,
    expectMode: index === 0 ? 'actual' : 'behavior',
    skill: index === 0 ? 'edit' : undefined,
    stateDir,
    actualChecks:
      index === 0
        ? { fileContains: { path: `workspace/${EDIT_TARGET_FILE}`, text: 'Hi world' } }
        : undefined,
    run: async () => {
      resetEditTarget();
      const result = await runE2E(query, { stateDir });
      const reply = result.reply ?? result;
      const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'edit' });
      if (!pass) {
        const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
        err.reply = reply;
        err.skillsCalled = result.skillsCalled;
        throw err;
      }
      return { reply, skillsCalled: result.skillsCalled, stateDir };
    },
  }));

  const { failed } = await runSkillTests('edit', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
