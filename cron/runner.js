/**
 * Cron runner. Schedules jobs from the store; when due, runs each job in a brand-new agent session
 * (separate process via cron/run-job.js) so the active chat bot never runs cron—only the child does.
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Cron } from 'croner';
import { loadJobs, removeJob, updateJob } from './store.js';
import { isTelegramChatId } from '../lib/telegram.js';
import { addPending as addPendingTelegram } from '../lib/pending-telegram.js';
import { getCronStorePath, getWorkspaceDir } from '../lib/paths.js';
import { toUserMessage, getErrorMessageForLog } from '../lib/user-error.js';
import { appendExchange } from '../lib/chat-log.js';
import { toLogJid } from '../lib/owner-config.js';
import { ensureChatSession, getCurrentSession } from '../lib/chat-session.js';
import { isTelegramGroupJid } from '../lib/telegram.js';
import { getMemoryConfig } from '../lib/memory-config.js';
import { indexChatExchange } from '../lib/memory-index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

/** @type {import('croner').Cron[]} */
const scheduled = [];
/** @type {NodeJS.Timeout[]} */
const oneShotTimeouts = [];
/** Set by startCron so scheduleOneShot can use them */
let currentSock = null;
/** Optional Telegram bot for jobs whose jid is a Telegram chat id */
let currentTelegramBot = null;
let currentSelfJid = null;
let currentStorePath = null;

/**
 * Send a text to jid (WhatsApp JID or Telegram chat id). Uses currentSock or currentTelegramBot.
 * On Telegram send failure, queues in pending-telegram for flush on next user message.
 */
async function sendCronReply(jid, text) {
  if (currentTelegramBot && isTelegramChatId(jid)) {
    try {
      await currentTelegramBot.sendMessage(jid, text);
    } catch (e) {
      addPendingTelegram(String(jid), text);
      console.log('[cron] Telegram reply queued (send failed, will retry on next message):', getErrorMessageForLog(e));
      return;
    }
  } else if (currentSock && typeof currentSock.sendMessage === 'function') {
    await currentSock.sendMessage(jid, { text });
  } else {
    throw new Error('No transport to send cron reply');
  }
}

const MAX_RETRIES = 2; // retry on failure only twice (1 initial + 2 retries = 3 attempts)
const RETRY_DELAYS_MS = [5000, 15000]; // exponential backoff: 5s, then 15s

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run a single cron job in a brand-new agent session (separate process). Throws on failure.
 * The main bot process only sends the reply; the child process runs the LLM and tools.
 *
 * @param {Object} opts
 * @param {import('./store.js').CronJob} opts.job
 * @param {object} opts.sock - Baileys socket (used when job.jid is WhatsApp)
 * @param {string} opts.selfJid - Fallback JID when job.jid is not set
 */
async function runJobOnce({ job, sock, selfJid }) {
  const jid = job.jid || selfJid;
  if (!jid) throw new Error('No JID for job');
  // Reply goes to job.jid (same channel where reminder was set up) when set; else selfJid fallback
  const storePath = currentStorePath || getCronStorePath();
  const payload = JSON.stringify({
    message: job.message,
    jid,
    storePath,
    workspaceDir: getWorkspaceDir(),
  });
  const textToSend = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cron/run-job.js'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('exit', (code, signal) => {
      if (code !== 0 && code != null) {
        reject(new Error(`run-job exited with code ${code}`));
        return;
      }
      if (signal) {
        reject(new Error(`run-job killed: ${signal}`));
        return;
      }
      // run-job writes exactly one JSON line; child may also log to stdout (e.g. agent), so use last line
      const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed.error) reject(new Error(parsed.error));
        else resolve(parsed.textToSend || '');
      } catch (e) {
        reject(new Error(lastLine.slice(0, 100) || e.message || 'run-job produced invalid output'));
      }
    });
    child.on('error', reject);
    child.stdin.end(payload, 'utf8');
  });
  const text = isTelegramChatId(jid) ? textToSend.replace(/^\[CowCode\]\s*/i, '').trim() : textToSend;
  if (text) {
    await sendCronReply(jid, text);
    const workspaceDir = getWorkspaceDir();
    // Group jids stay as-is (cron jobs to groups log into the group's main file
    // via the regular exchange path). Owner DM jids collapse into the unified
    // owner log so cron-driven check-ins live alongside the rest of the convo.
    const cronLogJid = isTelegramGroupJid(jid) ? jid : toLogJid(jid);
    const sessionKey = String(cronLogJid || jid).trim();
    ensureChatSession(sessionKey, {});
    const sessionId = getCurrentSession(sessionKey)?.sessionId;
    const exchange = {
      user: job.message || '',
      assistant: text,
      timestampMs: Date.now(),
      jid: cronLogJid,
      sessionId,
    };
    try {
      const memoryConfig = getMemoryConfig();
      if (memoryConfig) {
        await indexChatExchange(memoryConfig, exchange);
      } else {
        appendExchange(workspaceDir, exchange);
      }
    } catch (err) {
      console.error('[cron] Chat log write failed:', err.message);
    }
  }
}

/**
 * Run a cron job with up to 2 retries on failure (exponential backoff: 5s, 15s).
 * Exported for E2E tests that verify the send path (recording transport).
 * @param {Object} opts - same as runJobOnce
 */
export async function runJob({ job, sock, selfJid }) {
  const jid = job.jid || selfJid;
  if (!jid) {
    console.error('[cron] No JID for job', job.id, job.name);
    return;
  }
  console.log('[cron] Running job:', job.name, '→', jid);
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await runJobOnce({ job, sock, selfJid });
      if (attempt > 0) console.log('[cron] Sent after retry:', job.name);
      else console.log('[cron] Sent:', job.name);
      return;
    } catch (err) {
      lastErr = err;
      console.error('[cron] Job failed' + (attempt < MAX_RETRIES ? ` (attempt ${attempt + 1}/${MAX_RETRIES + 1})` : ''), job.name, err.message);
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_DELAYS_MS[attempt];
        console.log('[cron] Retrying in', Math.round(delayMs / 1000), 's');
        await sleep(delayMs);
      }
    }
  }
  try {
    await sendCronReply(jid, `[CowCode] Moo — reminder "${job.name}" didn't go through. ${toUserMessage(lastErr)}`);
  } catch (_) {}
}

/**
 * Start the cron runner: load jobs and schedule each enabled cron job and future one-shots.
 * Call this once WhatsApp is connected (so sock and selfJid are valid).
 * Optional telegramBot: reminders created from Telegram (job.jid = chat id) are sent via Telegram.
 *
 * @param {Object} opts
 * @param {object} opts.sock - Baileys socket (sendMessage). Not overwritten when agent passes a Telegram sock.
 * @param {string} opts.selfJid - Your WhatsApp JID for fallback when job.jid is missing
 * @param {string} [opts.storePath] - Path to cron/jobs.json
 * @param {import('node-telegram-bot-api')} [opts.telegramBot] - Optional Telegram bot for Telegram chat ids
 */
export function startCron({ sock, selfJid, storePath, telegramBot }) {
  if (sock != null && sock.user?.id !== 'telegram') {
    currentSock = sock;
  }
  if (telegramBot !== undefined) {
    currentTelegramBot = telegramBot || null;
  }
  if (selfJid != null) currentSelfJid = selfJid;
  if (storePath != null) currentStorePath = storePath;

  // Clear any previous schedules
  for (const c of scheduled) c.stop();
  scheduled.length = 0;
  for (const t of oneShotTimeouts) clearTimeout(t);
  oneShotTimeouts.length = 0;

  const jobs = loadJobs(storePath);
  const now = Date.now();

  const cronJobs = jobs.filter((j) => j.enabled && j.schedule?.kind === 'cron' && j.schedule?.expr);
  for (const job of cronJobs) {
    const expr = job.schedule.expr;
    const tz = job.schedule.tz || undefined;
    const cron = new Cron(expr, { timezone: tz }, async () => {
      await runJob({ job, sock, selfJid });
    });
    scheduled.push(cron);
    console.log('[cron] Scheduled:', job.name, expr, tz || '(local)');
  }

  const atJobs = jobs.filter((j) => j.enabled && j.schedule?.kind === 'at' && j.schedule?.at);
  for (const job of atJobs) {
    if (job.sentAtMs) continue; // Already sent (e.g. process died after send, before remove)
    const atMs = new Date(job.schedule.at).getTime();
    if (atMs > now) {
      scheduleOneShot(job);
    } else {
      // Due or overdue: mark sent first so restart never re-sends (even if we die after send, before remove)
      console.log('[cron] Running overdue one-shot:', job.name);
      updateJob(job.id, { sentAtMs: Date.now() }, storePath);
      runJob({ job, sock, selfJid }).then(() => removeJob(job.id, storePath));
    }
  }

  if (cronJobs.length === 0 && atJobs.length === 0) {
    console.log('[cron] No scheduled jobs in store. Add jobs via CLI or say e.g. "send me hi in 1 minute".');
  }
}

/**
 * Run any one-shot jobs that are past due (at <= now and not yet sent). Use when the user sends
 * a message so we catch up if something was missed (e.g. process was busy or startCron hadn't run).
 * Uses current sock/telegramBot/selfJid/storePath from startCron. No-op if no store or no transport.
 */
export async function runPastDueOneShots() {
  if (!currentStorePath || (!currentSock && !currentTelegramBot)) return;
  const jobs = loadJobs(currentStorePath);
  const now = Date.now();
  const atJobs = jobs.filter(
    (j) => j.enabled && j.schedule?.kind === 'at' && j.schedule?.at && !j.sentAtMs && new Date(j.schedule.at).getTime() <= now
  );
  for (const job of atJobs) {
    console.log('[cron] Running past-due one-shot:', job.name);
    updateJob(job.id, { sentAtMs: Date.now() }, currentStorePath);
    try {
      await runJob({ job, sock: currentSock, selfJid: currentSelfJid });
      removeJob(job.id, currentStorePath);
      console.log('[cron] Past-due one-shot sent and removed:', job.name);
    } catch (err) {
      console.error('[cron] Past-due one-shot failed:', job.name, err.message);
    }
  }
}

/**
 * Schedule a one-shot job to run at job.schedule.at. Uses current sock/selfJid/storePath from startCron.
 * Call this after addJob() when creating a job from chat (e.g. "send me X in N minutes").
 * Requires at least one transport (WhatsApp sock or Telegram bot) so the reply can be sent when due.
 * @param {import('./store.js').CronJob} job - Job with schedule.kind === 'at'
 */
export function scheduleOneShot(job) {
  if (job.schedule?.kind !== 'at' || !job.schedule.at || !currentStorePath) return;
  if (!currentSock && !currentTelegramBot) return;
  if (job.sentAtMs) return; // Already sent
  const atMs = new Date(job.schedule.at).getTime();
  const ms = atMs - Date.now();
  if (ms <= 0) return;
  const id = setTimeout(async () => {
    updateJob(job.id, { sentAtMs: Date.now() }, currentStorePath); // Mark sent before run so restart never re-sends
    await runJob({ job, sock: currentSock, selfJid: currentSelfJid });
    removeJob(job.id, currentStorePath);
    console.log('[cron] One-shot completed and removed from store:', job.name, '(message was sent by cron, not the chat LLM)');
  }, ms);
  oneShotTimeouts.push(id);
  console.log('[cron] One-shot scheduled:', job.name, 'in', Math.round(ms / 1000), 's');
}

/**
 * Stop all scheduled cron jobs and one-shots (e.g. on disconnect).
 */
export function stopCron() {
  for (const c of scheduled) c.stop();
  scheduled.length = 0;
  for (const t of oneShotTimeouts) clearTimeout(t);
  oneShotTimeouts.length = 0;
}

/** For E2E tests: assert one-shot was scheduled when only Telegram (no WhatsApp sock). */
export function getOneShotCountForTest() {
  return oneShotTimeouts.length;
}
