/**
 * E2E test for the Home Assistant skill: validates that our skill is accurate.
 * See scripts/test/E2E.md for what we test (project skill, not API/token).
 *
 * Flow: user message → main app LLM → home-assistant skill (CLI layer: ha-cli.js, env load, real fetch) → reply
 *       → separate LLM judge: did the user get what they wanted?
 *
 * - LLM chooses the home-assistant skill for "list my lights" / "what lights do I have"
 * - Skill runs via the HA CLI (skills/home-assistant/ha-cli.js); CLI loads HA_URL/HA_TOKEN from state dir .env
 * - CLI performs the real HA API call and returns the list to the user
 * No mocks: uses your real config and real Home Assistant. If HA is not configured or unreachable, the test fails.
 *
 * Prerequisites: home-assistant in skills.enabled, HA_URL/HA_TOKEN in ~/.pasture/.env, HA reachable.
 * Run: node scripts/test/test-home-assistant-e2e.js
 * Or:  pnpm run test:home-assistant-e2e
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { runSkillTests } from '../../support/skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from '../../support/e2e-judge.js';
import { skipSuiteIf } from '../../support/e2e-skip.js';
import dotenv from 'dotenv';
import { getEnvPath } from '../../../../lib/util/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const INSTALL_ROOT = process.env.PASTURE_INSTALL_DIR ? resolve(process.env.PASTURE_INSTALL_DIR) : ROOT;
const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 90_000;

/** Ensure real config has home-assistant enabled; throw with clear message if not. */
function ensureHomeAssistantEnabled() {
  const configPath = join(DEFAULT_STATE_DIR, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`No config at ${configPath}. Add home-assistant to skills.enabled and set HA_URL/HA_TOKEN in .env.`);
  }
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid config at ${configPath}: ${e && e.message}`);
  }
  const enabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : [];
  if (!enabled.includes('home-assistant')) {
    throw new Error(
      `home-assistant is not in skills.enabled at ${configPath}. Add "home-assistant" to config.skills.enabled and re-run.`
    );
  }
}

function runE2E(userMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(INSTALL_ROOT, 'index.js'), '--test', userMessage], {
      cwd: INSTALL_ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: DEFAULT_STATE_DIR },
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
        reject(new Error(`No E2E reply in output (code ${code}). stderr: ${stderr.slice(-400)}`));
        return;
      }
      const reply = stdout
        .slice(startIdx + E2E_REPLY_MARKER_START.length, endIdx)
        .replace(/^\n+|\n+$/g, '')
        .trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean) : [];
      resolve({ code, reply, stderr, skillsCalled });
    });
  });
}

async function main() {
  skipSuiteIf('home-assistant-e2e', () => {
    dotenv.config({ path: getEnvPath() });
    if (!process.env.HA_TOKEN?.trim()) return 'HA_TOKEN not set in ~/.pasture/.env';
    try {
      ensureHomeAssistantEnabled();
    } catch (e) {
      return e?.message || 'home-assistant not configured';
    }
    return null;
  });

  const tests = [
    {
      name: 'List my lights — LLM judge: user got what they wanted',
      expectMode: 'actual',
      skill: 'home-assistant',
      run: async () => {
        const userMessage = 'List my lights';
        const result = await runE2E(userMessage);
        const reply = result.reply;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(userMessage, reply, DEFAULT_STATE_DIR, { skillHint: 'home-assistant' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Bot reply (first 400 chars): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
    {
      name: 'What lights do I have — LLM judge: user got what they wanted',
      expectMode: 'behavior',
      run: async () => {
        const userMessage = 'What lights do I have?';
        const result = await runE2E(userMessage);
        const reply = result.reply;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(userMessage, reply, DEFAULT_STATE_DIR, { skillHint: 'home-assistant' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Bot reply (first 400 chars): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
    {
      name: 'List all my devices — so we see at least something returned from the API',
      expectMode: 'behavior',
      run: async () => {
        const userMessage = 'List all my devices';
        const result = await runE2E(userMessage);
        const reply = result.reply;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(userMessage, reply, DEFAULT_STATE_DIR, { skillHint: 'home-assistant' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Bot reply (first 400 chars): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
  ];

  const { passed, failed } = await runSkillTests('home-assistant', tests, {
    timeoutPerTest: PER_TEST_TIMEOUT_MS,
    installRoot: INSTALL_ROOT,
  });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
