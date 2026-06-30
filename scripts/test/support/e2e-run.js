/**
 * Shared E2E runner: user message → index.js --test (or chat-dashboard) → reply.
 * No inner-layer mocking — only transport (mock socket) is skipped.
 */

import { spawn } from 'child_process';
import { mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..', '..', '..');
export const INSTALL_ROOT = process.env.PASTURE_INSTALL_DIR ? process.env.PASTURE_INSTALL_DIR : ROOT;
export const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

export const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
export const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';
export const PER_TEST_TIMEOUT_MS = 120_000;

export function createTempStateDir() {
  const stateDir = join(tmpdir(), `pasture-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  return stateDir;
}

function parseE2EStdout(stdout) {
  const startIdx = stdout.indexOf(E2E_REPLY_MARKER_START);
  const endIdx = stdout.indexOf(E2E_REPLY_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }
  const reply = stdout
    .slice(startIdx + E2E_REPLY_MARKER_START.length, endIdx)
    .replace(/^\n+|\n+$/g, '')
    .trim();
  const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
  const skillsCalled = skillsMatch
    ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  return { reply, skillsCalled };
}

/**
 * Run the main app (--test): same path as Telegram private chat, minus network send.
 * @param {string} userMessage
 * @param {{ stateDir?: string, secondMessage?: string, testAgentId?: string, timeoutMs?: number }} [opts]
 */
export function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
  if (opts.secondMessage) env.TEST_MESSAGE_2 = opts.secondMessage;
  const timeoutMs = opts.timeoutMs || PER_TEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const args = [join(INSTALL_ROOT, 'index.js'), '--test', userMessage];
    if (opts.testAgentId) args.push('--test-agent', opts.testAgentId);
    const child = spawn('node', args, {
      cwd: INSTALL_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`E2E run timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
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
      const parsed = parseE2EStdout(stdout);
      if (!parsed) {
        reject(new Error(`No E2E reply in output (code ${code}). stderr: ${stderr.slice(-500)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${parsed.reply.slice(0, 200)}`));
        return;
      }
      resolve({ ...parsed, stderr, stdout });
    });
  });
}

/**
 * Run dashboard chat (web UI path): message → chat-dashboard.js → reply.
 * @param {string} message
 * @param {{ stateDir?: string, agentId?: string, timeoutMs?: number }} [opts]
 */
export function runDashboardE2E(message, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
  const timeoutMs = opts.timeoutMs || PER_TEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(ROOT, 'scripts/chat-dashboard.js')], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Dashboard E2E timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write(JSON.stringify({ message, agentId: opts.agentId || 'main' }));
    child.stdin.end();
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      let reply = '';
      let skillsCalled = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'done' && evt.reply) reply = String(evt.reply).trim();
        } catch (_) {}
      }
      const skillsMatch = stderr.match(/\[dashboard-skills\]\s*(.+)/) || stderr.match(/\[intent-planner\]\s*(\{[\s\S]*?\})/);
      if (skillsMatch) {
        if (skillsMatch[1].startsWith('{')) {
          try {
            const plan = JSON.parse(skillsMatch[1]);
            if (Array.isArray(plan.skills)) skillsCalled = plan.skills;
          } catch (_) {}
        } else {
          skillsCalled = skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean);
        }
      }
      if (!reply) {
        reject(new Error(`No dashboard reply (code ${code}). stderr: ${stderr.slice(-500)}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Dashboard exited ${code}. Reply: ${reply.slice(0, 200)}`));
        return;
      }
      resolve({ reply, skillsCalled, stderr, stdout });
    });
  });
}

export function isNoLlmError(err) {
  const msg = (err && err.message) || '';
  return (
    /API key not set|not set|ERR_INVALID_URL|ECONNREFUSED/.test(msg) ||
    /No config at|has no llm\.models/.test(msg)
  );
}
