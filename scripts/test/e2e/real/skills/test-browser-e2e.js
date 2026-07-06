/**
 * E2E tests: news/headlines and browser search through the main chatting interface.
 * See scripts/test/E2E.md for what we test (project skill, not API/token).
 *
 * Flow: user message → main app LLM → browser skill → reply → separate LLM judge: did the user get what they wanted?
 * Expect delay per test (AI + tool calls). Timeout per run: 2 minutes.
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { runSkillTests } from '../../../support/skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from '../../../support/e2e-judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

// How a human would ask (full questions).
const NEWS_QUERIES = [
  "What's the latest news?",
  "Can you give me the top five headlines?",
  "What are the headlines today?",
  "Tell me the current news",
  "What's in the news this week?",
  "Give me five headlines",
];

const NON_NEWS_QUERIES = [
  "What's the weather in London?",
  "What is the capital of France?",
];

// Browser: specific search/navigate queries (SEARCH intent, browser tool).
const BROWSER_SPECIFIC_QUERIES = [
  "summarize the Wikipedia page on quantum computing",
  "what's the current price of Bitcoin?",
  "find flights from Kathmandu to New York next week",
  "find the latest iPhone 16 reviews on tech sites",
  "go to nytimes.com and give me today's top stories",
  "weather forecast for Camp Hill, Pennsylvania tomorrow",
];

/**
 * Run the main app in --test mode with one message; return the reply text.
 * @param {string} userMessage
 * @returns {Promise<string>} Reply text (what would be sent to the user).
 */
function runE2E(userMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js', '--test', userMessage], {
      cwd: ROOT,
      env: process.env,
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
        reject(new Error(`No E2E reply in output (code ${code}). stderr: ${stderr.slice(-500)}`));
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
  console.log('E2E tests: each run goes through main chat (intent → LLM → tool → reply).');
  console.log('Expect ~30s–2min per test depending on LLM. Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const tests = [
    ...NEWS_QUERIES.map((query, i) => ({
      name: `news: "${query}"`,
      expectMode: i === 0 ? 'actual' : 'behavior',
      skill: i === 0 ? 'browser' : undefined,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'browser' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
    ...NON_NEWS_QUERIES.map((query, i) => ({
      name: `non-news: "${query}"`,
      expectMode: i === 0 ? 'actual' : 'behavior',
      skill: i === 0 ? 'browser' : undefined,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'browser' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
    ...BROWSER_SPECIFIC_QUERIES.map((query, i) => ({
      name: `browser: "${query}"`,
      expectMode: i === 0 ? 'actual' : 'behavior',
      skill: i === 0 ? 'browser' : undefined,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'browser' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
  ];

  const { failed } = await runSkillTests('browser', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
