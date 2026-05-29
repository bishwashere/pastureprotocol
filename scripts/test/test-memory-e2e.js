/**
 * E2E tests for memory: chat log is written, and memory recall works.
 * See scripts/test/E2E.md for what we test (project skill, not API/token).
 *
 * Flow: user message → main app LLM → memory skill → reply → separate LLM judge: did the user get what they wanted?
 *
 * 1. Chat log written — one message → assert workspace/chat-log/YYYY-MM-DD.jsonl contains the exchange.
 * 2. Memory recall — store a phrase, ask "what did we talk about yesterday?", then use an LLM judge to decide
 *    whether the bot answered the user's question (no regex or pattern matching).
 * 3. Filesystem index — use real app state (~/.cowcode). Create test dir in workspace, run index CLI, then main app
 *    with a user message asking for file-related memory; assert reply contains indexed file/dir names. Uses ~/.cowcode/memory/index.db.
 */

import { spawn, spawnSync } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import dotenv from 'dotenv';
import { runSkillTests } from './skill-test-runner.js';
import { getEnvPath } from '../../lib/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const INSTALL_ROOT = process.env.COWCODE_INSTALL_DIR ? resolve(process.env.COWCODE_INSTALL_DIR) : ROOT;
const DEFAULT_STATE_DIR = join(homedir(), '.cowcode');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

/** Phrase we store in the first message so the judge can verify the bot recalled it. */
const STORED_PHRASE = 'COWCODE_E2E_MAGIC_42';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Use LLM to judge whether the bot's reply answered the user's question.
 * @param {string} firstUserMessage - What the user said in the previous turn (what should be recalled).
 * @param {string} userQuestion - The question the user asked (e.g. "What did we talk about yesterday?").
 * @param {string} botReply - The bot's reply.
 * @param {string} stateDir - State dir (for config/env when calling LLM).
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
async function judgeRecall(firstUserMessage, userQuestion, botReply, stateDir) {
  const prevStateDir = process.env.COWCODE_STATE_DIR;
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    dotenv.config({ path: getEnvPath() });
    const { chat } = await import('../../llm.js');
    const judgePrompt = `You are a test judge. In a chat, the user first said:
---
${firstUserMessage}
---
Then in a later message (in a separate turn) the user asked:
---
${userQuestion}
---
The bot replied:
---
${botReply}
---
Did the bot answer the user's question? The bot has access to memory search over past messages. If the bot recalled or referenced what was discussed (the phrase or topic from the first message), or stated the phrase/topic in any form, answer YES. If the bot said it doesn't know, doesn't have that information, or the user didn't ask to remember anything, answer NO. Reply with exactly one line: YES or NO. Then add one short sentence explaining why.`;
    const response = await chat([
      { role: 'user', content: judgePrompt },
    ]);
    const trimmed = (response || '').trim().toUpperCase();
    const pass = trimmed.startsWith('YES');
    return { pass, reason: (response || '').trim().slice(0, 500) };
  } finally {
    if (prevStateDir !== undefined) process.env.COWCODE_STATE_DIR = prevStateDir;
    else delete process.env.COWCODE_STATE_DIR;
  }
}

/**
 * Create temp state dir with memory enabled. Copies config.json and .env from default state;
 * ensures skills.enabled includes 'memory'. Creates workspace dir.
 * @returns {{ stateDir: string, workspaceDir: string }}
 * @throws {Error} If no config.json in default state or config has no LLM models (tests need a working LLM).
 */
function createTempStateDir() {
  const stateDir = join(tmpdir(), 'cowcode-memory-e2e-' + Date.now());
  const workspaceDir = join(stateDir, 'workspace');
  const memoryDir = join(stateDir, 'memory');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });

  const defaultConfigPath = join(DEFAULT_STATE_DIR, 'config.json');
  if (!existsSync(defaultConfigPath)) {
    throw new Error('No config at ' + DEFAULT_STATE_DIR + '. Run setup first; memory E2E needs a working LLM.');
  }
  const raw = readFileSync(defaultConfigPath, 'utf8').trim();
  let config = {};
  try {
    config = JSON.parse(raw);
  } catch (_) {}
  const models = config.llm && Array.isArray(config.llm.models) ? config.llm.models : [];
  if (models.length === 0) {
    throw new Error('config.json has no llm.models. Memory E2E needs at least one LLM (and API key in .env).');
  }
  const skills = config.skills && typeof config.skills === 'object' ? config.skills : {};
  const enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
  if (!enabled.includes('memory')) {
    config.skills = { ...skills, enabled: [...enabled, 'memory'] };
  }
  // Ensure WhatsApp is enabled so --test uses the mock socket (not telegram-only path where sock is null).
  const channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
  const whatsapp = channels.whatsapp && typeof channels.whatsapp === 'object' ? channels.whatsapp : {};
  if (!whatsapp.enabled) {
    config.channels = { ...channels, whatsapp: { ...whatsapp, enabled: true } };
  }
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');

  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    let envContent = readFileSync(join(DEFAULT_STATE_DIR, '.env'), 'utf8');
    envContent = envContent
      .split('\n')
      .filter((line) => !/^\s*COWCODE_STATE_DIR\s*=/.test(line))
      .join('\n');
    writeFileSync(join(stateDir, '.env'), envContent.trimEnd() + '\nCOWCODE_STATE_DIR=' + stateDir + '\n', 'utf8');
  } else {
    writeFileSync(join(stateDir, '.env'), 'COWCODE_STATE_DIR=' + stateDir + '\n', 'utf8');
  }
  return { stateDir, workspaceDir };
}

/**
 * Run the main app in --test mode with one or two messages. With two messages, both run in the same process
 * so the memory index is shared (second message can recall the first).
 * @param {string} userMessage
 * @param {{ stateDir?: string, secondMessage?: string }} [opts]
 * @returns {Promise<{ reply: string, stderr: string }>}
 */
function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.COWCODE_STATE_DIR = opts.stateDir;
  if (opts.secondMessage) env.TEST_MESSAGE_2 = opts.secondMessage;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(INSTALL_ROOT, 'index.js'), '--test', userMessage], {
      cwd: INSTALL_ROOT,
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
      resolve({ reply, stderr, skillsCalled });
    });
  });
}

/**
 * Find the most recent chat-log file (by date) and return its path and lines.
 * @param {string} workspaceDir
 * @returns {{ path: string, lines: string[] } | null}
 */
function getLatestChatLog(workspaceDir) {
  const chatLogDir = join(workspaceDir, 'chat-log');
  if (!existsSync(chatLogDir)) return null;
  // Check top-level date-based files first, then per-JID private/ subdirectory.
  const names = readdirSync(chatLogDir).filter((n) => n.endsWith('.jsonl'));
  const privateDir = join(chatLogDir, 'private');
  if (existsSync(privateDir)) {
    const privateNames = readdirSync(privateDir).filter((n) => n.endsWith('.jsonl'));
    if (privateNames.length > 0) {
      privateNames.sort();
      const path = join(privateDir, privateNames[privateNames.length - 1]);
      const content = readFileSync(path, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());
      if (lines.length > 0) return { path, lines };
    }
  }
  if (names.length === 0) return null;
  names.sort();
  const path = join(chatLogDir, names[names.length - 1]);
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  return { path, lines };
}

/** Detect if failure is due to missing LLM config (no config, no models, no API key, etc.). */
function isNoLlmError(err) {
  const msg = (err && err.message) || '';
  return (
    /API key not set|not set|ERR_INVALID_URL|ECONNREFUSED/.test(msg) ||
    /No config at|has no llm\.models/.test(msg)
  );
}

async function main() {
  console.log('E2E memory tests: chat log written + memory recall (needs embedding for recall).');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.');
  if (INSTALL_ROOT !== ROOT) console.log('Using system install (COWCODE_INSTALL_DIR):', INSTALL_ROOT);
  console.log('');

  const storeMessage = `Memory e2e test message at ${Date.now()}.`;
  const storePhraseMessage = `Remember this exact phrase for the next message: ${STORED_PHRASE}.`;
  const recallQuery = 'Use your memory skill to search for what I asked you to remember in the previous message, then tell me that phrase.';

  const tests = [
    {
      name: 'memory: chat log written',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, workspaceDir } = createTempStateDir();
        const run = await runE2E(storeMessage, { stateDir });
        const reply = run.reply;
        assert(reply && reply.length > 0, 'Expected non-empty reply');
        const log = getLatestChatLog(workspaceDir);
        assert(log && log.lines.length >= 1, 'Expected at least one line in chat-log');
        const lastLine = log.lines[log.lines.length - 1];
        let parsed;
        try {
          parsed = JSON.parse(lastLine);
        } catch (_) {
          throw new Error('Chat log last line is not valid JSON');
        }
        assert(parsed.user === storeMessage, `Expected last exchange user to match. Got user: ${(parsed.user || '').slice(0, 80)}`);
        assert(parsed.assistant && parsed.assistant.length > 0, 'Expected non-empty assistant reply in chat log');
        return { reply, skillsCalled: run.skillsCalled };
      },
    },
    {
      name: 'memory: recall (store phrase → ask what I asked you to remember)',
      expectMode: 'actual',
      skill: 'memory',
      actualChecks: { replyIncludesAny: [STORED_PHRASE] },
      run: async () => {
        const { stateDir } = createTempStateDir();
        const run = await runE2E(storePhraseMessage, { stateDir, secondMessage: recallQuery });
        const reply2 = run.reply;
        assert(reply2 && reply2.length > 0, 'Expected non-empty reply to recall question');
        const { pass, reason } = await judgeRecall(storePhraseMessage, recallQuery, reply2, stateDir);
        const replyContainsPhrase = reply2 && reply2.includes(STORED_PHRASE);
        if (!pass && !replyContainsPhrase) {
          const stderrHint = run.stderr ? ` Stderr (last 300): ${run.stderr.slice(-300)}` : '';
          const err = new Error(`Memory recall failed: LLM judge said the bot did not answer the user's question. Judge: ${reason || 'NO'}. Bot reply (first 400 chars): ${(reply2 || '').slice(0, 400)}.${stderrHint}`);
          err.reply = reply2;
          err.skillsCalled = run.skillsCalled;
          throw err;
        }
        return { reply: reply2, skillsCalled: run.skillsCalled };
      },
    },
    {
      name: 'memory: filesystem index — query file-related memory and get filesystem results',
      expectMode: 'actual',
      actualChecks: { replyIncludesAny: ['e2e-fs-test', 'foo.txt', 'subdir', 'bar.js'] },
      run: async () => {
        const stateDir = DEFAULT_STATE_DIR;
        const workspaceDir = join(stateDir, 'workspace');
        const testDir = join(workspaceDir, 'e2e-fs-test');
        const subDir = join(testDir, 'subdir');
        mkdirSync(subDir, { recursive: true });
        writeFileSync(join(testDir, 'foo.txt'), 'e2e test file', 'utf8');
        writeFileSync(join(subDir, 'bar.js'), '// e2e', 'utf8');

        const indexScript = join(INSTALL_ROOT, 'scripts', 'index-cli.js');
        assert(existsSync(indexScript), 'scripts/index-cli.js not found');
        const indexResult = spawnSync(
          process.execPath,
          [indexScript, 'index', '--source', 'filesystem', '--root', workspaceDir, '--limit', '25'],
          {
            cwd: INSTALL_ROOT,
            env: { ...process.env, COWCODE_STATE_DIR: stateDir },
            encoding: 'utf8',
            timeout: 60000,
          }
        );
        if (indexResult.status !== 0) {
          const err = (indexResult.stderr || indexResult.stdout || '').slice(-500);
          throw new Error(`Index CLI failed (exit ${indexResult.status}): ${err}`);
        }

        const indexDbPath = join(stateDir, 'memory', 'index.db');
        assert(existsSync(indexDbPath), 'Index DB not found at ' + indexDbPath + '. Index CLI stdout: ' + (indexResult.stdout || '').slice(-400));
        console.log('[filesystem test] stateDir:', stateDir, 'index.db size:', statSync(indexDbPath).size);
        const userMessage = 'Search my memory for directory contents or list of files and folders, then tell me what files or directories you find.';
        const result = await runE2E(userMessage, { stateDir });
        const reply = result.reply;

        console.log('\n--- memory: filesystem index test (E2E) ---');
        console.log('Input (user message):', userMessage);
        console.log('Output (bot reply):', reply ? reply.slice(0, 500) + (reply.length > 500 ? '…' : '') : '(empty)');
        console.log('---\n');

        assert(reply && reply.length > 0, 'Expected non-empty reply');
        const hasIndexedContent =
          reply.includes('e2e-fs-test') ||
          reply.includes('foo.txt') ||
          reply.includes('subdir') ||
          reply.includes('bar.js');
        if (!hasIndexedContent) {
          const err = new Error(
            'Expected reply to include file/dir names from the indexed workspace (e2e-fs-test, foo.txt, subdir, bar.js). Reply (first 500 chars): ' +
              reply.slice(0, 500)
          );
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
  ];

  const { failed } = await runSkillTests('memory', tests);
  if (failed > 0) {
    console.log('\nMemory E2E: set LLM + embedding API key in .env for full recall test.');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
