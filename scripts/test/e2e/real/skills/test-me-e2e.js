/**
 * E2E tests for the me skill through the main chatting interface.
 * See scripts/test/E2E.md. Flow: user message → LLM → me skill → reply → judge.
 * Uses fixed fixture state (scripts/test/fixtures/state) so the bot has profile data to return.
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

const ME_QUERIES = [
  'What do you know about me?',
  'Summarize what you know about me',
  'What have you learned about me?',
  'Tell me about myself',
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
  console.log('E2E tests: me skill (user message → LLM → me → reply → judge).');
  console.log('Using fixed fixture state (fixtures/state) so the bot has profile data.\n');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = prepareStateFromFixture();

  const tests = ME_QUERIES.map((query, i) => ({
    name: `me: "${query}"`,
    expectMode: i === 0 ? 'actual' : 'behavior',
    skill: i === 0 ? 'me' : undefined,
    stateDir,
    actualChecks: i === 0 ? { replyIncludesAny: ['Test User'] } : undefined,
    run: async () => {
      const result = await runE2E(query, { stateDir });
      const reply = result.reply ?? result;
      const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'me' });
      if (!pass) {
        const err = new Error(`Judge: ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
        err.reply = reply;
        err.skillsCalled = result.skillsCalled;
        throw err;
      }
      return { reply, skillsCalled: result.skillsCalled, stateDir };
    },
  }));

  const { failed } = await runSkillTests('me', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
