/**
 * Basic Test — end-to-end agent scenarios covering:
 *   1. Simple greeting    — no tools should be called; reply should be clean
 *   2. Two-part question  — each part routes to the right tool; both answered
 *   3. Three-part question — completeness probe and retry mechanics exercised
 *
 * Each test checks:
 *   - The reply content (via LLM judge)
 *   - Which skills were called (structural assertion)
 *   - That internal reasoning never leaks into the reply
 *
 * Run:
 *   node scripts/test/test-basic-e2e.js
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
const PER_TEST_TIMEOUT_MS = 120_000;

// Phrases that indicate internal reasoning leaked into the reply
const INTERNAL_LEAK_PATTERNS = [
  /don'?t need (web )?search/i,
  /retrying with search/i,
  /no tool calls/i,
  /skill called/i,
  /completeness probe/i,
  /\[retry with search\]/i,
  /<skill\s+action/i,
];

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-basic-e2e-' + Date.now());
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
      reject(new Error(`Timed out after ${PER_TEST_TIMEOUT_MS / 1000}s`));
    }, PER_TEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const startIdx = stdout.indexOf('E2E_REPLY_START');
      const endIdx = stdout.indexOf('E2E_REPLY_END');
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        reject(new Error(`No E2E reply markers (exit ${code}). stderr: ${stderr.slice(-500)}`));
        return;
      }
      const reply = stdout
        .slice(startIdx + 'E2E_REPLY_START'.length, endIdx)
        .replace(/^\n+|\n+$/g, '')
        .trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch
        ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${reply.slice(0, 200)}`));
        return;
      }
      resolve({ reply, skillsCalled, stderr });
    });
  });
}

/** Assert that internal reasoning phrases did not leak into the reply. */
function assertNoInternalLeak(reply) {
  for (const pattern of INTERNAL_LEAK_PATTERNS) {
    if (pattern.test(reply)) {
      throw new Error(`Internal reasoning leaked into reply: "${reply.slice(0, 200)}"`);
    }
  }
}

/** Assert that every expected skill was called. */
function assertSkillsCalled(skillsCalled, expected) {
  for (const skill of expected) {
    if (!skillsCalled.includes(skill)) {
      throw new Error(`Expected skill "${skill}" to be called but got: [${skillsCalled.join(', ')}]`);
    }
  }
}

/** Assert that none of the forbidden skills were called. */
function assertSkillsNotCalled(skillsCalled, forbidden) {
  for (const skill of forbidden) {
    if (skillsCalled.includes(skill)) {
      throw new Error(`Skill "${skill}" should NOT have been called but was. Skills called: [${skillsCalled.join(', ')}]`);
    }
  }
}

async function main() {
  console.log('Basic Test — agent E2E scenarios\n');
  const stateDir = createTempStateDir();

  const tests = [
    // ─────────────────────────────────────────────────────────
    // 1. Simple greeting — no tools needed, clean reply only
    // ─────────────────────────────────────────────────────────
    {
      name: 'greeting: "hi" → clean reply, no tools, no internal leak',
      expectMode: 'behavior',
      run: async () => {
        const { reply, skillsCalled } = await runE2E('hi', { stateDir });
        assertNoInternalLeak(reply);
        assertSkillsNotCalled(skillsCalled, ['search', 'browse']);
        const { pass, reason } = await judgeUserGotWhatTheyWanted('hi', reply, stateDir, {
          prompt: `The user said "hi". The bot replied:\n\n---\n${reply}\n---\n\nDid the bot respond naturally and conversationally (any friendly greeting or offer to help is fine)? Answer NO only if the reply explains internal tool decisions, mentions search/skills, or is clearly not a conversational reply to a greeting.\nAnswer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    },

    // ─────────────────────────────────────────────────────────
    // 2. Two-part question — each part goes to the right tool
    //    Part A: something needing web search (outdoor/weather)
    //    Part B: something needing a local/home tool (indoor home sensor)
    //    Both parts must be answered; tools must split correctly
    // ─────────────────────────────────────────────────────────
    {
      name: 'two-part: outdoor weather + indoor home sensor → both answered, correct tool split',
      expectMode: 'actual',
      skill: ['search', 'home-assistant'],
      run: async () => {
        const message = 'What is the outdoor temperature and what is the indoor temperature?';
        const { reply, skillsCalled } = await runE2E(message, { stateDir });
        assertNoInternalLeak(reply);
        // Outdoor must have gone to search; indoor to home-assistant
        assertSkillsCalled(skillsCalled, ['search', 'home-assistant']);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
          prompt: `The user asked: "${message}"\nThe bot replied:\n\n---\n${reply}\n---\n\nDid the reply address BOTH parts — outdoor temperature (from web/weather) AND indoor/home temperature (from a local sensor or home system)? Both must be present or clearly attempted. If either is completely missing, answer NO.\nAnswer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    },

    // ─────────────────────────────────────────────────────────
    // 3. Three-part question — completeness probe exercised
    //    Three distinct asks in one message; all must be answered.
    //    Tests that the completeness probe catches any gap and
    //    retries with the right tool rather than repeating search.
    // ─────────────────────────────────────────────────────────
    {
      name: 'three-part: news + home device state + math → all three answered, probe handles gaps',
      expectMode: 'actual',
      actualChecks: { replyIncludesAny: ['221'] },
      run: async () => {
        const message = 'Give me the top 1 news headline, tell me if the living room light is on, and what is 17 times 13?';
        const { reply, skillsCalled } = await runE2E(message, { stateDir });
        assertNoInternalLeak(reply);
        // Judge is the sole arbiter here — all three parts must be present and correct.
        // We do not assert specific skills because math needs no tool and the LLM may
        // legitimately choose different tools for different parts.
        const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
          prompt: `The user asked three things: (1) top news headline, (2) whether the living room light is on, (3) what 17 × 13 equals (221).\nThe bot replied:\n\n---\n${reply}\n---\n\nDid the reply address all three? The math answer must be 221. The news must be a real headline (not "I don't know" or empty). The light state must be reported or clearly attempted. If any of the three is completely missing or the math is wrong, answer NO.\nAnswer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    },
  ];

  const { failed } = await runSkillTests('basic', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
