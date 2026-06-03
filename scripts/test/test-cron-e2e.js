/**
 * E2E tests for cron (list / add / manage) through the main chatting interface.
 * See scripts/test/E2E.md for what we test (project skill, not API/token).
 *
 * Flow: user message → main app LLM → cron skill → reply → separate LLM judge: did the user get what they wanted?
 *
 * Skill-facing tests (add, list, manage, recurring) use the LLM judge. Internal contract tests
 * (exact job count, run-job stdout, one-shot when Telegram-only, channel send) keep code assertions.
 */

import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { homedir, tmpdir } from 'os';
import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
/** Use system install (all-users) when PASTURE_INSTALL_DIR is set; otherwise run from repo. */
const INSTALL_ROOT = process.env.PASTURE_INSTALL_DIR ? resolve(process.env.PASTURE_INSTALL_DIR) : ROOT;
const DEFAULT_STATE_DIR = join(homedir(), '.pasture');

const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
const PER_TEST_TIMEOUT_MS = 120_000;

// Cron list: user asks to see scheduled reminders (cron tool action "list").
const CRON_LIST_QUERIES = [
  "List my reminders",
  "What's scheduled?",
  "Do I have anything scheduled?",
  "Do I have any reminders?",
  "Show my scheduled reminders",
];

// Cron add: user asks to create a reminder (cron tool action "add").
const CRON_ADD_QUERIES = [
  "Remind me in 2 minutes to water the plants",
  "Remind me to call John in 3 minutes",
  "Send me a hello message in 1 minute",
  "remind me in 5 minutes to drink water",
  "remind me to call mom tomorrow at 9am",
  "set a reminder for grocery shopping in 2 hours",
  "remind me every Monday to take out the trash",
  "create a daily reminder at 8pm to review code",
];

// Recurring (cron expr): every 5 mins, every morning, etc. Optional expectedExpr pattern (regex or string).
const CRON_RECURRING_ADD_QUERIES = [
  { query: 'Remind me every 5 minutes to stretch', expectedExpr: '*/5 * * * *' },
  { query: 'Every morning at 8am remind me to drink water', expectedExpr: '0 8 * * *' },
  { query: 'Create a daily reminder at 9am for standup', expectedExpr: '0 9 * * *' },
  { query: 'remind me every hour to take a break', expectedExpr: '0 * * * *' },
];

// Cron manage: list reminders or remove/delete (remove needs job id; "delete all" may get explanation).
const REMINDER_MANAGE_QUERIES = [
  "list my reminders",
  "show all my reminders",
  "what reminders do I have?",
  "remove reminder number 3",          // assuming prior setup in test
  "delete all reminders",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Create a temp state dir with empty cron store. Copies config.json and .env from default state dir
 * so the child process has LLM config (otherwise we get ERR_INVALID_URL for baseUrl).
 * Uses tmpdir so it works when INSTALL_ROOT is read-only (e.g. system install for all users).
 * @returns {{ stateDir: string, storePath: string }}
 */
function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-cron-e2e-' + Date.now());
  const cronDir = join(stateDir, 'cron');
  const storePath = join(cronDir, 'jobs.json');
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(storePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), 'utf8');
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  return { stateDir, storePath };
}

/**
 * Run the main app in --test mode with one message; return the reply text.
 * @param {string} userMessage
 * @param {object} [opts] - Optional. If opts.stateDir is set, use it as PASTURE_STATE_DIR so the cron store is isolated.
 * @returns {Promise<string>} Reply text (what would be sent to the user).
 */
function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
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
      resolve({ reply, skillsCalled });
    });
  });
}

/** Load cron store from path; returns { version, jobs }. */
function loadStore(storePath) {
  if (!existsSync(storePath)) return { version: 1, jobs: [] };
  const raw = readFileSync(storePath, 'utf8').trim();
  try {
    const data = JSON.parse(raw);
    return { version: data.version ?? 1, jobs: Array.isArray(data.jobs) ? data.jobs : [] };
  } catch {
    return { version: 1, jobs: [] };
  }
}

const RUN_JOB_TIMEOUT_MS = 30_000;

/**
 * Force-execute a single cron job payload (same as runner does): run cron/run-job.js with message + jid.
 * Asserts output is valid JSON with textToSend (or error). Uses opts.stateDir for PASTURE_STATE_DIR so config/.env are loaded.
 * @param {string} message - Job message (prompt to LLM)
 * @param {object} [opts] - { stateDir } for isolated state (default: DEFAULT_STATE_DIR)
 * @returns {Promise<{ textToSend?: string, error?: string }>}
 */
function runJobOnce(message, opts = {}) {
  const stateDir = opts.stateDir || DEFAULT_STATE_DIR;
  const storePath = join(stateDir, 'cron', 'jobs.json');
  const workspaceDir = join(stateDir, 'workspace');
  const payload = JSON.stringify({
    message: String(message || 'Hello'),
    jid: 'test-e2e@s.whatsapp.net',
    storePath,
    workspaceDir,
  });
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(INSTALL_ROOT, 'cron', 'run-job.js')], {
      cwd: INSTALL_ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`run-job timed out after ${RUN_JOB_TIMEOUT_MS / 1000}s`));
    }, RUN_JOB_TIMEOUT_MS);
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
      const line = stdout.trim().split('\n').pop() || '';
      try {
        const parsed = JSON.parse(line);
        if (parsed.error) resolve({ error: parsed.error });
        else resolve({ textToSend: parsed.textToSend });
      } catch (e) {
        reject(new Error(`run-job invalid output (code ${code}): ${line.slice(0, 200)}. stderr: ${stderr.slice(-300)}`));
      }
    });
    child.stdin.end(payload, 'utf8');
  });
}

/** Format jobs for table cell: one line per job (at/expr + message). */
function formatCronSet(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return '—';
  return jobs
    .map((j) => {
      const msg = (j.message || '').slice(0, 60) + ((j.message || '').length > 60 ? '…' : '');
      if (j.schedule?.kind === 'at' && j.schedule?.at) return `at ${j.schedule.at} → "${msg}"`;
      if (j.schedule?.kind === 'cron' && j.schedule?.expr) return `cron ${j.schedule.expr} → "${msg}"`;
      return `"${msg}"`;
    })
    .join('; ');
}

/** Escape pipe and newline for markdown table cell. */
function cell(s) {
  return String(s ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

async function runReport() {
  const rows = [];
  const allQueries = [
    ...CRON_LIST_QUERIES.map((q) => ({ query: q, type: 'list' })),
    ...CRON_ADD_QUERIES.map((q) => ({ query: q, type: 'add' })),
    { query: 'Remind me to check lock after two minutes', type: 'add-single' },
    ...CRON_RECURRING_ADD_QUERIES.map(({ query }) => ({ query, type: 'add-recurring' })),
    ...REMINDER_MANAGE_QUERIES.map((q) => ({ query: q, type: 'manage' })),
  ];
  console.log('Cron E2E report: running each query and capturing reply + store…\n');
  for (const { query, type } of allQueries) {
    try {
      let reply = '';
      let cronSet = '—';
      if (type === 'add' || type === 'add-single' || type === 'add-recurring') {
        const { stateDir, storePath } = createTempStateDir();
        const res = await runE2E(query, { stateDir });
        reply = res.reply ?? res;
        const { jobs } = loadStore(storePath);
        cronSet = formatCronSet(jobs);
      } else {
        const res = await runE2E(query);
        reply = res.reply ?? res;
      }
      rows.push({ query, reply, cronSet });
      console.log('  ✓', query.slice(0, 50) + (query.length > 50 ? '…' : ''));
    } catch (err) {
      rows.push({ query, reply: `(error: ${err.message})`, cronSet: '—' });
      console.log('  ✗', query.slice(0, 50), err.message);
    }
  }
  const outPath = join(__dirname, 'CRON_E2E_TABLE.md');
  const lines = [
    '# Cron E2E: tabulated from test run',
    '',
    '| User said | Reply | Cron set |',
    '|-----------|-------|----------|',
    ...rows.map((r) => `| ${cell(r.query)} | ${cell(r.reply)} | ${cell(r.cronSet)} |`),
  ];
  writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log('\nWrote', outPath);
}

async function main() {
  console.log('E2E cron tests: intent → LLM → cron tool → reply.');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.');
  if (INSTALL_ROOT !== ROOT) console.log('Using system install (PASTURE_INSTALL_DIR):', INSTALL_ROOT);
  console.log('');

  const singleAddQuery = 'Remind me to check lock after two minutes';
  const tests = [
    ...CRON_ADD_QUERIES.map((query) => ({
      name: `cron add: "${query}"`,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'cron' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
    {
      name: `cron add: exact job count — "${singleAddQuery}"`,
      run: async () => {
        const { stateDir, storePath } = createTempStateDir();
        const result = await runE2E(singleAddQuery, { stateDir });
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(singleAddQuery, reply, stateDir, { skillHint: 'cron' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        const { jobs } = loadStore(storePath);
        assert(jobs.length === 1, `One "add" message must create exactly one job; got ${jobs.length}. Duplicate-add bug.`);
        const atTimes = jobs.filter((j) => j.schedule?.kind === 'at' && j.schedule?.at).map((j) => j.schedule.at);
        assert(new Set(atTimes).size === atTimes.length, `All one-shot jobs must have unique "at" times; got duplicates.`);
        return { reply, skillsCalled: result.skillsCalled };
      },
    },
    ...CRON_LIST_QUERIES.map((query) => ({
      name: `cron list: "${query}"`,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'cron' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
    ...CRON_RECURRING_ADD_QUERIES.map(({ query, expectedExpr }) => ({
      name: `cron recurring: "${query}"`,
      run: async () => {
        const { stateDir, storePath } = createTempStateDir();
        const result = await runE2E(query, { stateDir });
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, stateDir, { skillHint: 'cron' });
        if (!pass) {
          const err = new Error(`Judge: user did not get what they wanted. ${reason || 'NO'}. Reply (first 400): ${(reply || '').slice(0, 400)}`);
          err.reply = reply;
          err.skillsCalled = result.skillsCalled;
          throw err;
        }
        const { jobs } = loadStore(storePath);
        const cronJobs = jobs.filter((j) => j.schedule?.kind === 'cron' && j.schedule?.expr);
        assert(cronJobs.length >= 1, `Expected at least one cron (recurring) job for "${query}"; got ${jobs.length} jobs, cron: ${cronJobs.length}.`);
        if (expectedExpr) {
          const found = cronJobs.some((j) => j.schedule.expr === expectedExpr);
          assert(found, `Expected cron expr "${expectedExpr}" for "${query}". Got: ${cronJobs.map((j) => j.schedule.expr).join(', ')}`);
        }
        return { reply, skillsCalled: result.skillsCalled };
      },
    })),
    {
      name: 'cron execute: run-job textToSend',
      run: async () => {
        const message = 'Reminder: Cron E2E execute test OK';
        const result = await runJobOnce(message, { stateDir: DEFAULT_STATE_DIR });
        assert(!result.error, `run-job should not return error; got: ${result.error}`);
        assert(result.textToSend && result.textToSend.length > 0, `run-job should return non-empty textToSend; got: ${JSON.stringify(result)}`);
        const hasExpected = /Cron E2E execute test OK|execute test OK/i.test(result.textToSend);
        assert(result.textToSend.length > 10 && (hasExpected || result.textToSend.length > 30), `run-job should return substantive reply; got (first 200): ${result.textToSend.slice(0, 200)}`);
        return { reply: result.textToSend };
      },
    },
    {
      name: 'cron one-shot when Telegram-only (no sock)',
      run: async () => {
        const { stateDir, storePath } = createTempStateDir();
        const runnerPath = pathToFileURL(join(INSTALL_ROOT, 'cron', 'runner.js')).href;
        const storePathMod = pathToFileURL(join(INSTALL_ROOT, 'cron', 'store.js')).href;
        const runner = await import(runnerPath);
        const store = await import(storePathMod);
        const atTime = new Date(Date.now() + 120_000).toISOString();
        runner.startCron({ storePath, telegramBot: {} });
        const job = store.addJob({ name: 'E2E Telegram one-shot', message: 'hi', schedule: { kind: 'at', at: atTime }, jid: '7656021862' }, storePath);
        runner.scheduleOneShot(job);
        const count = runner.getOneShotCountForTest();
        assert(count === 1, `One-shot must be scheduled when only telegramBot is set. Got getOneShotCountForTest()=${count}.`);
      },
    },
    {
      name: 'cron send to channel (recording transport)',
      run: async () => {
        const { stateDir, storePath } = createTempStateDir();
        const runnerPath = pathToFileURL(join(INSTALL_ROOT, 'cron', 'runner.js')).href;
        const storePathMod = pathToFileURL(join(INSTALL_ROOT, 'cron', 'store.js')).href;
        const runner = await import(runnerPath);
        const store = await import(storePathMod);
        const sent = [];
        const spyTelegramBot = {
          sendMessage: async (jid, text) => {
            sent.push({ jid: String(jid), text: String(text) });
            return { message_id: 1 };
          },
        };
        runner.startCron({ storePath, telegramBot: spyTelegramBot });
        const job = store.addJob(
          { name: 'Channel send test', message: 'channel send test OK', schedule: { kind: 'at', at: new Date(Date.now() + 60_000).toISOString() }, jid: '999888777' },
          storePath
        );
        await runner.runJob({ job, sock: null, selfJid: null });
        assert(sent.length === 1, `sendMessage must be called exactly once; got ${sent.length}`);
        assert(sent[0].jid === '999888777', `Expected jid 999888777; got ${sent[0].jid}`);
        assert(sent[0].text.includes('channel send test OK') || sent[0].text.length > 10, `Reply must contain expected phrase or be substantive; got (first 120): ${sent[0].text.slice(0, 120)}`);
      },
    },
    ...REMINDER_MANAGE_QUERIES.map((query) => ({
      name: `cron manage: "${query}"`,
      run: async () => {
        const result = await runE2E(query);
        const reply = result.reply ?? result;
        const { pass, reason } = await judgeUserGotWhatTheyWanted(query, reply, DEFAULT_STATE_DIR, { skillHint: 'cron' });
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

  const { passed, failed } = await runSkillTests('cron', tests);

  console.log('\n--- Report ---');
  await runReport();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
