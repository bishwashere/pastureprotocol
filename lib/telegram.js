/**
 * Telegram bot: sock-like interface so the same agent/cron flow can send to Telegram.
 * Set TELEGRAM_BOT_TOKEN in env (or in ~/.cowcode/.env) to enable.
 */

import TelegramBot from 'node-telegram-bot-api';
import { getErrorMessageForLog } from './user-error.js';

let bot = null;
let lastConnectionIssueLog = 0;
const CONNECTION_ISSUE_LOG_COOLDOWN_MS = 60_000; // log at most once per minute for transient errors

/** Watchdog state — tracks polling health so Tide can detect and heal silent failures. */
let lastPollActivityMs = Date.now();
let consecutivePollingErrors = 0;
let pollingRestartInProgress = false;
const CONSECUTIVE_ERROR_RESTART = 8; // restart after this many errors in a row without a successful message
const POLL_DEAD_THRESHOLD_MS = 4 * 60 * 1000; // 4 min of no poll activity → treat as dead

/** Network-down recovery: when ENOTFOUND/EADDRNOTAVAIL fires we switch to an aggressive
 *  offline-retry loop (every 15 s) so the bot comes back online immediately when internet
 *  is restored — rather than waiting for the slow 8-error burst threshold or 8-min watchdog. */
let networkDownSince = 0; // ms timestamp; 0 = online
let offlineRetryTimer = null;
const OFFLINE_RETRY_INTERVAL_MS = 15_000;

/**
 * @param {string} token - Bot token from @BotFather
 * @returns {TelegramBot}
 */
export function initBot(token) {
  if (!token || !String(token).trim()) return null;
  bot = new TelegramBot(token.trim(), { polling: true });
  bot.on('polling_error', (err) => {
    lastPollActivityMs = Date.now();
    consecutivePollingErrors += 1;
    const msg = getErrorMessageForLog(err);
    if (msg.includes('409') || msg.includes('Conflict') || msg.includes('getUpdates')) {
      console.log('[Telegram] Another cowCode is already using this bot; this process won\'t get Telegram messages. To use this process instead, stop the other: cowcode stop');
      bot.stopPolling().catch(() => {});
      consecutivePollingErrors = 0;
    } else {
      const isHardNetworkError = /ENOTFOUND|EADDRNOTAVAIL|EAI_AGAIN/i.test(msg);
      const isTransient = isHardNetworkError || /ETIMEDOUT|ECONNRESET|socket hang up|EFATAL|AggregateError/i.test(msg);
      const now = Date.now();
      if (isTransient && now - lastConnectionIssueLog < CONNECTION_ISSUE_LOG_COOLDOWN_MS) {
        // still count the error for the consecutive threshold even if we suppress the log
      } else {
        if (isTransient) lastConnectionIssueLog = now;
        const hint = isTransient ? ' (transient; polling will retry)' : '';
        console.log('[Telegram] Connection issue:', msg.slice(0, 120) + (msg.length > 120 ? '…' : '') + hint);
      }
      // Hard network failure (DNS unreachable, address unavailable) → enter offline mode:
      // kick off a dedicated retry loop so we reconnect immediately when internet returns.
      if (isHardNetworkError && networkDownSince === 0) {
        networkDownSince = Date.now();
        console.log('[Telegram] Network down — starting offline retry loop (every', OFFLINE_RETRY_INTERVAL_MS / 1000, 's).');
        scheduleOfflineRetry(bot);
      }
      // Burst-failure self-heal: restart polling immediately after too many consecutive errors.
      if (consecutivePollingErrors >= CONSECUTIVE_ERROR_RESTART && !pollingRestartInProgress) {
        console.log(`[Telegram] ${consecutivePollingErrors} consecutive polling errors; restarting polling now.`);
        consecutivePollingErrors = 0;
        restartPolling(bot);
      }
    }
  });
  // Any received message proves the polling loop is alive — reset the watchdog counters.
  bot.on('message', () => {
    lastPollActivityMs = Date.now();
    consecutivePollingErrors = 0;
  });

  return bot;
}

/** Shared restart logic used by both the burst handler and ensurePollingAlive. */
async function restartPolling(targetBot) {
  if (pollingRestartInProgress) return;
  pollingRestartInProgress = true;
  try {
    await targetBot.stopPolling().catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    await targetBot.startPolling();
    lastPollActivityMs = Date.now();
    consecutivePollingErrors = 0;
    // Coming back from a hard network outage — announce recovery and clear offline state.
    if (networkDownSince > 0) {
      const downSecs = Math.round((Date.now() - networkDownSince) / 1000);
      console.log(`[Telegram] Back online after ${downSecs}s — polling active, bot ready.`);
      networkDownSince = 0;
      if (offlineRetryTimer) {
        clearTimeout(offlineRetryTimer);
        offlineRetryTimer = null;
      }
    } else {
      console.log('[Telegram] Polling restarted successfully.');
    }
  } catch (e) {
    console.error('[Telegram] Polling restart failed:', getErrorMessageForLog(e));
  } finally {
    pollingRestartInProgress = false;
  }
}

/** Retry loop used during network outages: attempts restartPolling every OFFLINE_RETRY_INTERVAL_MS
 *  until the connection is re-established, at which point restartPolling clears the timer itself. */
function scheduleOfflineRetry(targetBot) {
  if (offlineRetryTimer || networkDownSince === 0) return;
  offlineRetryTimer = setTimeout(async () => {
    offlineRetryTimer = null;
    if (networkDownSince === 0) return; // already recovered via another path
    await restartPolling(targetBot);
    // If still offline (networkDownSince still set), schedule the next attempt.
    if (networkDownSince > 0) scheduleOfflineRetry(targetBot);
  }, OFFLINE_RETRY_INTERVAL_MS);
}

/**
 * Called by Tide's global interval on every health-check tick to detect and heal a dead polling loop.
 * Uses two signals: isPolling() for explicit stops, and a getUpdates health-ping
 * combined with inactivity time to catch silent failures.
 * @param {TelegramBot} targetBot
 */
export async function ensurePollingAlive(targetBot) {
  if (!targetBot || pollingRestartInProgress) return;

  // Explicit stop (e.g. 409 Conflict from another process) — do not auto-restart.
  if (!targetBot.isPolling()) {
    console.log('[Telegram] Polling is stopped (was halted intentionally); skipping restart.');
    return;
  }

  // If we've seen recent activity (error or message), polling is still trying.
  if (Date.now() - lastPollActivityMs < POLL_DEAD_THRESHOLD_MS) return;

  // No activity for 8+ minutes — confirm the API is reachable before deciding.
  try {
    await targetBot.getUpdates({ limit: 1, timeout: 0 });
    // API responded fine: update the activity clock so we don't keep re-checking
    // every Tide cycle when the chat is simply quiet.
    lastPollActivityMs = Date.now();
    // If the API works but the internal loop might still be silently dead, restart
    // as a precaution. The restart is fast (~3 s gap) and harmless if polling was fine.
    console.log('[Telegram] No poll activity for 8+ min; restarting polling as a precaution.');
  } catch (e) {
    const msg = getErrorMessageForLog(e);
    // 409 means another process owns this bot — don't fight it.
    if (msg.includes('409') || msg.includes('Conflict')) return;
    console.log('[Telegram] Polling health-ping failed:', msg.slice(0, 80), '— restarting polling.');
    // Hard network error from health-ping → enter offline retry loop just like polling_error does.
    const isHardNetworkError = /ENOTFOUND|EADDRNOTAVAIL|EAI_AGAIN/i.test(msg);
    if (isHardNetworkError && networkDownSince === 0) {
      networkDownSince = Date.now();
      console.log('[Telegram] Network down (health-ping) — starting offline retry loop (every', OFFLINE_RETRY_INTERVAL_MS / 1000, 's).');
      scheduleOfflineRetry(targetBot);
      return; // scheduleOfflineRetry will call restartPolling
    }
  }

  await restartPolling(targetBot);
}

export function getBot() {
  return bot;
}

/** Telegram chat IDs are numeric (user) or negative (groups). WhatsApp JIDs contain '@'. */
export function isTelegramChatId(jid) {
  if (jid == null) return false;
  const s = String(jid).trim();
  return /^-?\d+$/.test(s);
}

/** True if jid is a Telegram group/supergroup (negative chat id). Used to keep group log/memory separate from main. */
export function isTelegramGroupJid(jid) {
  if (jid == null) return false;
  const n = parseInt(String(jid).trim(), 10);
  return !Number.isNaN(n) && n < 0;
}

/** Telegram Bot API limit is 4096; use 4000 to leave a small buffer. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

/**
 * Split text into chunks each at most maxLen characters, breaking at newlines or spaces when possible.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
export function chunkTextForTelegram(text, maxLen = TELEGRAM_MAX_MESSAGE_LENGTH) {
  if (!text || text.length <= maxLen) return text ? [text] : [];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf('\n');
    const lastSpace = slice.lastIndexOf(' ');
    const splitAt = lastNewline >= 0 ? lastNewline + 1 : (lastSpace >= 0 ? lastSpace + 1 : maxLen);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).replace(/^\s+/, '');
  }
  return chunks;
}

const MAX_PART_HEADER_LEN = 20; // e.g. "(Part 99/99)\n\n"
const SEND_RETRIES = 3;
const SEND_RETRY_DELAY_MS = 1500;

/** Retry a send on transient errors (EFATAL, AggregateError, ECONNRESET, etc.). */
async function sendWithRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= SEND_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = getErrorMessageForLog(e);
      const isTransient = /EFATAL|AggregateError|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|ECONNREFUSED/i.test(msg);
      if (!isTransient || attempt === SEND_RETRIES) throw e;
      const delay = SEND_RETRY_DELAY_MS * attempt;
      console.log('[Telegram] Retry send in', delay, 'ms (attempt', attempt + 1, 'of', SEND_RETRIES + '):', msg.slice(0, 60));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Send text to a Telegram chat, splitting into multiple messages if over the API limit.
 * @param {import('node-telegram-bot-api')} bot
 * @param {number} chatId
 * @param {string} text
 * @returns {Promise<{ key: { id: string } }>} Last sent message key for compatibility
 */
export async function sendLongText(bot, chatId, text) {
  const maxChunk = TELEGRAM_MAX_MESSAGE_LENGTH - MAX_PART_HEADER_LEN;
  const chunks = chunkTextForTelegram(text ?? '', maxChunk);
  if (chunks.length === 0) {
    const sent = await sendWithRetry(() => bot.sendMessage(chatId, ''));
    return { key: { id: sent.message_id?.toString?.() ?? 'tg-' + Date.now() } };
  }
  let lastSent = null;
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks.length > 1 ? `(Part ${i + 1}/${chunks.length})\n\n${chunks[i]}` : chunks[i];
    lastSent = await sendWithRetry(() => bot.sendMessage(chatId, part));
  }
  return { key: { id: lastSent?.message_id?.toString?.() ?? 'tg-' + Date.now() } };
}

/**
 * Sock-like object for runAgentWithSkills and sendMessage compatibility.
 * sendMessage(chatId, { text }) -> sends text, paginated if over Telegram limit
 * sendMessage(chatId, { voice: buffer }) -> bot.sendVoice(chatId, buffer) for voice replies
 * sendMessage(chatId, { image: buffer, caption }) -> bot.sendPhoto(chatId, buffer, { caption }) for image replies
 */
export function createTelegramSock(telegramBot) {
  if (!telegramBot) return null;
  return {
    sendMessage: async (chatId, opts) => {
      if (opts?.voice && Buffer.isBuffer(opts.voice)) {
        const sent = await sendWithRetry(() =>
          telegramBot.sendVoice(chatId, opts.voice, { filename: 'reply.ogg' })
        );
        return { key: { id: sent.message_id?.toString?.() ?? 'tg-' + Date.now() } };
      }
      if (opts?.image && Buffer.isBuffer(opts.image)) {
        const caption = (opts.caption && String(opts.caption).trim()) || '';
        const sent = await sendWithRetry(() =>
          telegramBot.sendPhoto(chatId, opts.image, caption ? { caption } : {})
        );
        return { key: { id: sent.message_id?.toString?.() ?? 'tg-' + Date.now() } };
      }
      const text = opts?.text ?? '';
      return sendLongText(telegramBot, chatId, text);
    },
    sendPresenceUpdate: () => {},
    user: { id: 'telegram' },
  };
}
