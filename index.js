/**
 * WhatsApp + configurable LLM. On incoming message → LLM reply → send back.
 * Config and state live in ~/.cowcode (or COWCODE_STATE_DIR).
 */

import { getAuthDir, getCronStorePath, getConfigPath, getEnvPath, ensureStateDir, getWorkspaceDir, getUploadsDir, getStateDir, getAgentWorkspaceDir } from './lib/paths.js';
import dotenv from 'dotenv';

dotenv.config({ path: getEnvPath() });

// Log to daemon.log so "tail -f" shows when the process actually started (after cowcode start/restart)
console.log(`[${new Date().toISOString().replace(/\.\d{3}Z$/, '')}] cowCode daemon started`);

import * as Baileys from '@whiskeysockets/baileys';

const makeWASocket =
  typeof Baileys.makeWASocket === 'function' ? Baileys.makeWASocket : Baileys.default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  extractMessageContent,
  areJidsSameUser,
  downloadMediaMessage,
} = Baileys;
import { loadConfig, chat as llmChat } from './llm.js';
import { runAgentTurn, stripThinking } from './lib/agent.js';
import { runInternalAgentTurn } from './lib/internal-agent-turn.js';
import { planIntent, intentPlanToSystemBlock } from './lib/intent-planner.js';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { spawn } from 'child_process';
import pino from 'pino';
import { startCron, stopCron, scheduleOneShot, runPastDueOneShots } from './cron/runner.js';
import { getSkillsEnabled, getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries, DEFAULT_ENABLED } from './skills/loader.js';
import { initBot, createTelegramSock, isTelegramChatId, isTelegramGroupJid, sendLongText, ensurePollingAlive } from './lib/telegram.js';
import { isWhatsAppGroupJid } from './lib/whatsapp.js';
import { addPending as addPendingTelegram, clearPending as clearPendingTelegram, flushPending } from './lib/pending-telegram.js';
import { getChannelsConfig } from './lib/channels-config.js';
import { getSchedulingTimeContext, isInTideInactiveWindow } from './lib/timezone.js';
import {
  defaultTideChecklistBlock,
  shouldRunChecklistForTrigger,
  runTideChecklist,
} from './lib/tide-checklist.js';
import { getOwnerConfig, isOwner } from './lib/owner-config.js';
import { getGroupAddedBy, setGroupAddedBy } from './lib/telegram-group-added-by.js';
import { isTelegramGroup } from './lib/group-guard.js';
import { getMemoryConfig } from './lib/memory-config.js';
import { indexChatExchange } from './lib/memory-index.js';
import {
  migrateRetrospectiveConfig,
  startRetrospective,
  afterExchangeLogged,
  beforeUserMessage,
  buildRetrospectiveContextBlock,
} from './lib/retrospective.js';
import { appendExchange, appendGroupExchange, readLastGroupExchanges, readLastPrivateExchanges } from './lib/chat-log.js';
import { ensureChatSession } from './lib/chat-session.js';
import { buildSessionBootstrapContext } from './lib/session-bootstrap.js';
import { toLogJid, getOwnerLogJid } from './lib/owner-config.js';
import { handleTelegramPrivateMessage } from './lib/telegram-private-handler.js';
import { handleTelegramGroupMessage } from './lib/telegram-group-handler.js';
import { ensureGroupConfigFor } from './lib/group-config.js';
import { loadGroupMd, buildGroupPromptBlock } from './lib/group-prompt.js';
import { buildOneOnOneSystemPrompt } from './lib/system-prompt.js';
import { ensureMainAgentInitialized, resolveAgentIdForGroup, readAgentMd, DEFAULT_AGENT_ID } from './lib/agent-config.js';
import { recoverStaleBackgroundTasks, formatTasksList, spawnBackgroundTask } from './lib/background-tasks.js';
import { getGroupDisplayName, setGroupDisplayName, parseSetDisplayNameMessage } from './lib/group-display-names.js';
import { resetBrowseSession } from './lib/executors/browse.js';
import { toUserMessage, getErrorMessageForLog } from './lib/user-error.js';
import { getSpeechConfig, transcribe, synthesizeToBuffer } from './lib/speech-client.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const qrcodeTerminal = require('qrcode-terminal');

const __dirname = dirname(fileURLToPath(import.meta.url));

if (typeof makeWASocket !== 'function') {
  throw new Error('Baileys makeWASocket not found. Check @whiskeysockets/baileys version.');
}

const authOnly = process.argv.includes('--auth-only');
const pairIndex = process.argv.indexOf('--pair');
const pairNumber = pairIndex !== -1 ? process.argv[pairIndex + 1] : null;

// Keys we never log (signal/session key material and noisy proto fields)
const REDACT_KEYS = new Set([
  'indexInfo', 'baseKey', 'baseKeyType', 'remoteIdentityKey', 'pendingPreKey',
  'signedKeyId', 'keyPair', 'private', 'public', 'signature', 'identifierKey',
]);

function redactForLog(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Buffer.isBuffer(obj) || (typeof Uint8Array !== 'undefined' && obj instanceof Uint8Array)) return '[Buffer]';
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.has(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = redactForLog(v);
  }
  return out;
}

// In auth mode show connection errors so we can see why linking fails
const pinoLogger = pino({ level: authOnly ? 'error' : 'silent' });
function logWithRedact(pinoInstance, level, a, b) {
  if (typeof a === 'string' && b === undefined) {
    pinoInstance[level](a);
    return;
  }
  const obj = typeof a === 'object' && a !== null ? redactForLog(a) : a;
  const msg = b;
  pinoInstance[level](obj, msg);
}

const logger = {
  get level() { return pinoLogger.level; },
  set level(v) { pinoLogger.level = v; },
  child(bindings) {
    return wrapForRedaction(pinoLogger.child(bindings));
  },
  trace(a, b) { logWithRedact(pinoLogger, 'trace', a, b); },
  debug(a, b) { logWithRedact(pinoLogger, 'debug', a, b); },
  info(a, b) { logWithRedact(pinoLogger, 'info', a, b); },
  warn(a, b) { logWithRedact(pinoLogger, 'warn', a, b); },
  error(a, b) { logWithRedact(pinoLogger, 'error', a, b); },
};

function writeDaemonStarted() {
  try {
    const path = join(getStateDir(), 'daemon.started');
    writeFileSync(path, JSON.stringify({ startedAt: Date.now() }), 'utf8');
  } catch (_) {}
}

function wrapForRedaction(pinoInstance) {
  return {
    get level() { return pinoInstance.level; },
    set level(v) { pinoInstance.level = v; },
    child(b) { return wrapForRedaction(pinoInstance.child(b)); },
    trace(a, b) { logWithRedact(pinoInstance, 'trace', a, b); },
    debug(a, b) { logWithRedact(pinoInstance, 'debug', a, b); },
    info(a, b) { logWithRedact(pinoInstance, 'info', a, b); },
    warn(a, b) { logWithRedact(pinoInstance, 'warn', a, b); },
    error(a, b) { logWithRedact(pinoInstance, 'error', a, b); },
  };
}

// Patch console so deps (e.g. Baileys WAM/encode) never log key material to stdout
const _consoleLog = console.log;
const _consoleInfo = console.info;
const _consoleDebug = console.debug;
const _consoleWarn = console.warn;
function redactConsoleArgs(args) {
  return args.map((a) => {
    if (a !== null && typeof a === 'object') return redactForLog(a);
    if (typeof a === 'string' && a.length > 200) {
      const t = a.trim();
      if (t.startsWith('{') || t.startsWith('[')) return a.slice(0, 60) + '… [truncated]';
    }
    return a;
  });
}
console.log = (...args) => _consoleLog(...redactConsoleArgs(args));
console.info = (...args) => _consoleInfo(...redactConsoleArgs(args));
console.debug = (...args) => _consoleDebug(...redactConsoleArgs(args));
console.warn = (...args) => _consoleWarn(...redactConsoleArgs(args));

const DISCONNECT_REASONS = {
  401: 'Logged out',
  403: 'Forbidden (e.g. banned)',
  408: 'Connection lost / timed out',
  411: 'Multi-device not enabled (enable in WhatsApp Settings → Linked devices)',
  428: 'Connection closed',
  440: 'Connection replaced (another client linked)',
  500: 'Bad session',
  503: 'WhatsApp service unavailable',
  515: 'Restart required (reconnecting…)',
};

const RESTART_REQUIRED_CODE = 515;

/** Codes for which we do not retry reconnect (user must re-auth). */
const NO_RETRY_CODES = new Set([401, 403]);

const RECONNECT_DELAYS_MS = [5000, 15000, 30000, 60000]; // exponential backoff, max 60s

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create WhatsApp socket with saved auth; resolves when connection is open, rejects if closed before open.
 * @returns {Promise<ReturnType<makeWASocket>>}
 */
async function connectWhatsApp() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(getAuthDir());
  const keyStoreLogger = wrapForRedaction(pino({ level: 'silent' }));
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, keyStoreLogger),
    },
    logger,
  });
  sock.ev.on('creds.update', saveCreds);
  return new Promise((resolve, reject) => {
    sock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') resolve(sock);
      if (u.connection === 'close' && u.lastDisconnect) {
        const code = u.lastDisconnect.error?.output?.statusCode ?? u.lastDisconnect.error?.statusCode;
        reject(Object.assign(new Error('closed'), { code }));
      }
    });
  });
}

/**
 * @param {{ continueToBot?: boolean }} opts - If true, after link we continue to run the bot (no exit).
 */
async function runAuthOnly(opts = {}) {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(getAuthDir());

  const keyStoreLogger = wrapForRedaction(pino({ level: 'silent' }));
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, keyStoreLogger),
    },
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    sock.ev.on('connection.update', async (u) => {
      if (u.connection === 'open') {
        if (opts.continueToBot) {
          console.log('[connection] connection successful');
          console.log('Please send a message to your own number to get started.');
        } else {
          console.log('[connection] connection successful');
          console.log('Linked. You can Ctrl+C and run cowcode start.');
        }
        resolve(sock);
        return;
      }
      if (u.connection === 'close' && u.lastDisconnect) {
        const err = u.lastDisconnect.error;
        const code = err?.output?.statusCode ?? err?.statusCode;
        const reason = DISCONNECT_REASONS[code] || `Code ${code}`;
        if (code === RESTART_REQUIRED_CODE) {
          try { sock.end(undefined); } catch (_) {}
          resolve('restart');
          return;
        }
        reject(new Error(reason));
        return;
      }
      if (u.qr) {
        qrcodeTerminal.generate(u.qr, { small: true });
        console.log('Scan with WhatsApp (Linked devices).');
      }
    });

    if (pairNumber) {
      const digits = pairNumber.replace(/\D/g, '');
      if (digits.length < 10) {
        reject(new Error('Usage: pnpm run auth -- --pair <full-phone-number> (e.g. 1234567890)'));
        return;
      }
      sock.requestPairingCode(digits)
        .then((code) => {
          console.log('Pairing code (enter in WhatsApp → Linked devices → Link with phone number):', code);
        })
        .catch((e) => reject(e));
    }
  });
}

/** Migration: ensure all default skills (cron, search, browse, vision, memory, speech, etc.) are in skills.enabled so new installs and updates get them without fresh install. */
function migrateSkillsConfigToIncludeDefaults() {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    const config = JSON.parse(raw);
    const skills = config.skills || {};
    let enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
    let changed = false;
    for (const id of DEFAULT_ENABLED) {
      if (!enabled.includes(id)) {
        enabled = [...enabled, id];
        changed = true;
      }
    }
    if (!changed) return;
    config.skills = { ...skills, enabled };
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {}
}

/** Migration: ensure tide config block exists so it can be enabled by the user. Default: enabled false. */
function migrateTideConfig() {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    const config = JSON.parse(raw);
    if (config.tide != null && typeof config.tide === 'object') {
      if (!config.tide.checklist) {
        config.tide.checklist = defaultTideChecklistBlock();
        writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
      }
      return;
    }
    config.tide = {
      enabled: false,
      silenceCooldownMinutes: 30,
      inactiveStart: '23:00',
      inactiveEnd: '06:00',
      checklist: defaultTideChecklistBlock(),
    };
    writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {}
}

async function main() {
  ensureStateDir();
  recoverStaleBackgroundTasks();
  ensureMainAgentInitialized();
  migrateSkillsConfigToIncludeDefaults();
  migrateTideConfig();
  migrateRetrospectiveConfig();
  if (authOnly && existsSync(getAuthDir())) {
    rmSync(getAuthDir(), { recursive: true });
    mkdirSync(getAuthDir(), { recursive: true });
  }

  if (authOnly) {
    while (true) {
      try {
        const result = await runAuthOnly();
        if (result !== 'restart') break;
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    }
    return;
  }

  let sock;
  const channelsConfig = getChannelsConfig();
  const envTelegramOnly = process.env.COWCODE_TELEGRAM_ONLY === '1' || process.env.COWCODE_TELEGRAM_ONLY === 'true';
  const telegramOnlyMode = (envTelegramOnly || (channelsConfig.telegram.enabled && !channelsConfig.whatsapp.enabled)) && !!channelsConfig.telegram.botToken;
  const credsPath = join(getAuthDir(), 'creds.json');
  const needAuth = !existsSync(getAuthDir()) || !existsSync(credsPath);

  // E2E tests need the mock socket regardless of channel config.
  if (process.argv.includes('--test')) {
    sock = {
      sendMessage: async () => ({ key: { id: 'test-' + Date.now() } }),
      sendPresenceUpdate: async () => {},
      readMessages: async () => {},
    };
  } else if (telegramOnlyMode) {
    sock = null;
  } else if (needAuth) {
    console.log('');
    console.log('  ─────────────────────────────────────────');
    console.log('  Link your WhatsApp');
    console.log('  ─────────────────────────────────────────');
    console.log('');
    console.log('  No session found. A QR code will appear below.');
    console.log('  Open WhatsApp → Linked devices → Link a device, then scan the code.');
    console.log('');
    while (true) {
      try {
        const result = await runAuthOnly({ continueToBot: true });
        if (result !== 'restart') {
          sock = result;
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.error(e.message);
        process.exit(1);
      }
    }
  } else {
    sock = null; // will be set by connectWhatsApp() in the reconnect loop below
  }

  /** Current WhatsApp sock for Tide follow-ups (set when connection opens in runBot). */
  const whatsappSockRef = { current: null };

  /** Set in runBot (WhatsApp: initBot; Telegram-only: opts); null in --test so cron ctx does not throw. */
  let telegramBot = null;

  /** Returns a function that resolves to the given bot's username (cached after first getMe()). */
  function createGetBotUsername(bot) {
    let cached = undefined;
    return async function getBotUsername() {
      if (!bot) return null;
      if (cached !== undefined) return cached;
      try {
        const me = await bot.getMe();
        cached = me.username ?? null;
        return cached;
      } catch {
        cached = null;
        return null;
      }
    };
  }

  const config = loadConfig();
  const first = config.models[0];
  console.log('LLM config:', config.models.length > 1
    ? `${config.models.length} models (priority): ${config.models.map(m => m.model).join(' → ')}`
    : { baseUrl: first.baseUrl, model: first.model });
  const skillsEnabled = getSkillsEnabled();
  console.log('Skills enabled:', skillsEnabled?.length ? skillsEnabled.join(', ') : 'cron (default)');

  const MAX_REPLIED_IDS = 500;
  const MAX_OUR_SENT_IDS = 200;
  const MAX_CHAT_HISTORY_EXCHANGES = Math.max(1, Math.floor(Number(config.chatHistoryExchanges)) || 5);

  /** Pending WhatsApp replies when send failed (e.g. disconnected); flushed when connection reopens. */
  const pendingReplies = [];

  /** Last N exchanges (user + assistant) per jid for LLM context. Step 1: chat + history + tools. */
  const chatHistoryByJid = new Map();
  function pushExchange(jid, userContent, assistantContent, sessionId) {
    let list = chatHistoryByJid.get(jid);
    if (!list) list = [];
    list.push({ user: userContent, assistant: assistantContent, sessionId });
    if (list.length > MAX_CHAT_HISTORY_EXCHANGES) list = list.slice(-MAX_CHAT_HISTORY_EXCHANGES);
    chatHistoryByJid.set(jid, list);
  }

  function clearInMemoryHistoryForJids(...jids) {
    for (const id of jids) {
      if (id != null && String(id).trim()) chatHistoryByJid.delete(String(id).trim());
    }
  }

  function getLast5ExchangesForSession(jid, sessionId) {
    const list = chatHistoryByJid.get(jid);
    if (!list || list.length === 0) return [];
    const filtered = sessionId ? list.filter((ex) => ex.sessionId === sessionId) : list;
    const out = [];
    for (const ex of filtered) {
      out.push({ role: 'user', content: ex.user });
      out.push({ role: 'assistant', content: ex.assistant });
    }
    return out;
  }

  // Agent logic: getSkillContext() called on every run; compact list in tool; full doc injected when a skill is called.

  /**
   * Tide: per-JID follow-up state.
   * Maps jid → { dueMs } where dueMs is when the next follow-up conversation check is due.
   * A global interval fires frequently for the polling health check; it also runs follow-ups for
   * JIDs whose dueMs has elapsed. This decouples the health-check cadence from the cooldown period.
   */
  const tideTimerByJid = new Map();
  /** JIDs currently being processed by runTideForJid — prevents concurrent runs for the same JID. */
  const tideRunningJids = new Set();
  /** Handle for the global Tide interval. */
  let tideGlobalInterval = null;
  let tideChecklistRunning = false;
  async function maybeRunTideChecklist(trigger) {
    if (tideChecklistRunning) return;
    const config = getTideConfig();
    if (!shouldRunChecklistForTrigger(trigger, { tide: config.tide || {} })) return;
    tideChecklistRunning = true;
    try {
      await runTideChecklist({ trigger, telegramBot });
    } catch (e) {
      console.error('[tide-checklist]', getErrorMessageForLog(e));
    } finally {
      tideChecklistRunning = false;
    }
  }
  function getTideConfig() {
    try {
      const raw = readFileSync(getConfigPath(), 'utf8');
      if (raw?.trim()) return JSON.parse(raw);
    } catch (_) {}
    return {};
  }
  async function runTideForJid(tideJid) {
    const tideJidShort = String(tideJid).slice(0, 20) + (String(tideJid).length > 20 ? '…' : '');
    let config = getTideConfig();
    const tide = config.tide || {};
    if (!tide.enabled) return;
    const inactiveStart = tide.inactiveStart && String(tide.inactiveStart).trim();
    const inactiveEnd = tide.inactiveEnd && String(tide.inactiveEnd).trim();
    if (inactiveStart && inactiveEnd && isInTideInactiveWindow(inactiveStart, inactiveEnd)) return;
    await maybeRunTideChecklist('onFollowUp');
    const isTgJid = isTelegramChatId(tideJid);
    const waSock = whatsappSockRef.current;
    if (isTgJid && !telegramBot) return;
    if (!isTgJid && !waSock?.sendMessage) return;
    // Polling watchdog: runs on every Tide cycle regardless of whether a follow-up is sent.
    // This is how Tide acts as a self-healing heartbeat — not just a quiet-chat nudge.
    if (isTgJid && telegramBot) {
      await ensurePollingAlive(telegramBot).catch((e) =>
        console.error('[tide] polling health check error:', getErrorMessageForLog(e))
      );
    }
    const isTgGroup = isTelegramGroupJid(tideJid);
    const tideLogJid = isTgGroup ? tideJid : toLogJid(tideJid);
    const tideSessionKey = String(tideLogJid || tideJid).trim();
    const tideSession = ensureChatSession(tideSessionKey, {});
    const tideSessionId = tideSession.sessionId;
    if (tideSession.rotated) {
      console.log('[tide] New session for', tideSessionKey, '—', tideSessionId);
    }
    const tideBootstrap = buildSessionBootstrapContext(getWorkspaceDir(), {
      logJid: isTgGroup ? undefined : tideLogJid,
    }).block;
    const historyMessages = isTgGroup
      ? readLastGroupExchanges(getWorkspaceDir(), tideJid, 5, tideSessionId)
      : readLastPrivateExchanges(getWorkspaceDir(), tideLogJid, 5, tideSessionId);
    // Old UX preserved: only send one follow-up per "round". Once we've sent a Tide message,
    // don't send another until the user replies. The health check above still runs every cycle.
    const lastUserMsg = historyMessages.length >= 2 ? historyMessages[historyMessages.length - 2] : null;
    const alreadySentTide = lastUserMsg?.role === 'user' && lastUserMsg?.content === 'Tide check';
    if (!alreadySentTide) {
      const payload = JSON.stringify({
        jid: tideJid,
        storePath: getCronStorePath(),
        workspaceDir: getWorkspaceDir(),
        historyMessages,
        bootstrapBlock: tideBootstrap,
      });
      let textToSend = '';
      let sendOk = false;
      try {
        textToSend = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['cron/run-tide.js'], {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'inherit'],
            env: { ...process.env, COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR },
          });
          let out = '';
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk) => { out += chunk; });
          child.on('exit', (code, signal) => {
            if (code !== 0 && code != null) {
              reject(new Error(`run-tide exited with code ${code}`));
              return;
            }
            if (signal) {
              reject(new Error(`run-tide killed: ${signal}`));
              return;
            }
            const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
            try {
              const parsed = JSON.parse(lastLine);
              if (parsed.error) reject(new Error(parsed.error));
              else resolve(parsed.textToSend || '');
            } catch (e) {
              reject(new Error(lastLine.slice(0, 100) || e.message || 'run-tide invalid output'));
            }
          });
          child.on('error', reject);
          child.stdin.end(payload, 'utf8');
        });
        sendOk = true;
      } catch (e) {
        console.error('[tide] run-tide failed:', getErrorMessageForLog(e));
      }
      if (sendOk) {
        const rawText = sanitizeOutboundText((textToSend || '').trim());
        let text = isTelegramChatId(tideJid) ? rawText.replace(/^\[CowCode\]\s*/i, '').trim() : rawText;
        const nothingPhrases = /^(nothing|n\/?a|no(ne)?\s*to\s*do|all\s*good|nothing\s*to\s*report\.?)\s*\.?$/i;
        if (!text || (text.length < 50 && nothingPhrases.test(text))) {
          text = "What would you like to do next?";
        }
        try {
          if (isTgJid && telegramBot) {
            await sendLongText(telegramBot, Number(tideJid), text);
          } else if (waSock?.sendMessage) {
            await waSock.sendMessage(tideJid, { text });
          }
          console.log('[tide] Follow-up sent to', tideJidShort);
        } catch (e) {
          console.error('[tide] Send failed:', getErrorMessageForLog(e));
        }
        // Group: keep tideJid (group log). Private DM: collapse owner DMs into the
        // unified owner log so Tide check-ins live alongside the rest of the convo.
        const exchange = {
          user: 'Tide check',
          assistant: text,
          timestampMs: Date.now(),
          jid: tideLogJid,
          sessionId: tideSessionId,
        };
        try {
          if (isTgGroup) {
            appendGroupExchange(getWorkspaceDir(), tideJid, exchange);
          } else {
            const memoryConfig = getMemoryConfig();
            if (memoryConfig) {
              await indexChatExchange(memoryConfig, exchange);
            } else {
              appendExchange(getWorkspaceDir(), exchange);
            }
          }
        } catch (err) {
          console.error('[tide] Chat log write failed:', err.message);
        }
      }
    }
    // Reset the per-JID cooldown so the next follow-up fires after another full cooldown period.
    scheduleTideFollowUp(tideJid);
  }
  function scheduleTideFollowUp(jid) {
    const config = getTideConfig();
    const tide = config.tide || {};
    if (!tide.enabled) return;
    const cooldownMinutes = Math.max(1, Number(tide.silenceCooldownMinutes) || 30);
    const dueMs = Date.now() + cooldownMinutes * 60 * 1000;
    const jidShort = String(jid).slice(0, 20) + (String(jid).length > 20 ? '…' : '');
    const isReset = tideTimerByJid.has(jid);
    tideTimerByJid.set(jid, { dueMs });
    if (isReset) {
      console.log('[tide] Timer reset for', jidShort, '— follow-up due in', cooldownMinutes, 'min');
    } else {
      console.log('[tide] Scheduled follow-up for', jidShort, 'in', cooldownMinutes, 'min');
    }
  }
  function startTide(sockRef, selfJidRef) {
    console.log('[tide] startTide() called');
    const config = getTideConfig();
    const tide = config.tide || {};
    if (!tide.enabled) {
      console.log('[tide] Disabled. Set tide.enabled to true in config for follow-ups after private replies.');
      return;
    }
    const cooldownMinutes = Math.max(1, Number(tide.silenceCooldownMinutes) || 30);
    // healthCheckMinutes controls how often Tide wakes up to run the polling watchdog and check
    // for due follow-ups. It must be <= silenceCooldownMinutes to catch due JIDs on time.
    const healthCheckMinutes = Math.min(
      Math.max(1, Number(tide.healthCheckMinutes) || 2),
      cooldownMinutes
    );
    console.log('[tide] Enabled. Follow-up cooldown:', cooldownMinutes, 'min. Health-check interval:', healthCheckMinutes, 'min.');
    if (tideGlobalInterval) clearInterval(tideGlobalInterval);
    maybeRunTideChecklist('onRestart');
    buildSessionBootstrapContext(getWorkspaceDir(), { logJid: getOwnerLogJid() });
    tideGlobalInterval = setInterval(() => {
      maybeRunTideChecklist('onCycle');
      // 1. Always run the Telegram polling watchdog, independent of any active conversation.
      if (telegramBot) {
        ensurePollingAlive(telegramBot).catch((e) =>
          console.error('[tide] polling health check error:', getErrorMessageForLog(e))
        );
      }
      // 2. Fire conversation follow-ups for any JID whose cooldown has elapsed.
      const now = Date.now();
      for (const [jid, entry] of tideTimerByJid) {
        if (now >= entry.dueMs && !tideRunningJids.has(jid)) {
          const jidShort = String(jid).slice(0, 20) + (String(jid).length > 20 ? '…' : '');
          console.log('[tide] Follow-up due for', jidShort);
          tideRunningJids.add(jid);
          runTideForJid(jid)
            .catch((e) => console.error('[tide]', getErrorMessageForLog(e)))
            .finally(() => tideRunningJids.delete(jid));
        }
      }
    }, healthCheckMinutes * 60 * 1000);
  }
  function stopTide() {
    if (tideGlobalInterval) {
      clearInterval(tideGlobalInterval);
      tideGlobalInterval = null;
    }
    tideTimerByJid.clear();
    tideRunningJids.clear();
    console.log('[tide] Stopped.');
  }

  const WHO_AM_I_MD = 'WhoAmI.md';
  const MY_HUMAN_MD = 'MyHuman.md';
  const SOUL_MD = 'SOUL.md';
  const GROUP_MD = 'group.md';

  const WORKSPACE_DEFAULT_FILES = [WHO_AM_I_MD, MY_HUMAN_MD, SOUL_MD, GROUP_MD];
  const INSTALL_DIR = (process.env.COWCODE_INSTALL_DIR && resolve(process.env.COWCODE_INSTALL_DIR)) || __dirname;
  const DEFAULT_WORKSPACE_DIR = join(INSTALL_DIR, 'workspace-default');

  function readWorkspaceMd(filename) {
    const p = join(getWorkspaceDir(), filename);
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    } catch (_) {}
    return '';
  }

  /** Copy repo workspace-default/*.md into state workspace if they don't exist. */
  function ensureWorkspaceDefaults() {
    try {
      ensureStateDir();
      const workspaceDir = getWorkspaceDir();
      for (const name of WORKSPACE_DEFAULT_FILES) {
        const dest = join(workspaceDir, name);
        if (existsSync(dest)) continue;
        const src = join(DEFAULT_WORKSPACE_DIR, name);
        if (existsSync(src)) copyFileSync(src, dest);
      }
    } catch (err) {
      console.error('[workspace] could not copy default files:', err.message);
    }
  }

  function ensureSoulMd() {
    ensureWorkspaceDefaults();
  }

  /** Read initial soul from workspace-default/SOUL.md when workspace/group have no SOUL.md. */
  function readDefaultSoul() {
    const p = join(DEFAULT_WORKSPACE_DIR, SOUL_MD);
    try {
      if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    } catch (_) {}
    return '';
  }

  function getBioFromConfig() {
    try {
      const raw = readFileSync(getConfigPath(), 'utf8');
      const full = JSON.parse(raw);
      return full.bio || null;
    } catch (_) {
      return null;
    }
  }

  function isBioSet() {
    if (readWorkspaceMd(WHO_AM_I_MD) || readWorkspaceMd(MY_HUMAN_MD)) return true;
    const bio = getBioFromConfig();
    if (bio == null) return false;
    if (typeof bio === 'string') return (bio || '').trim() !== '';
    return typeof bio === 'object' && (bio.userName != null || bio.prompt != null);
  }

  function saveBioToConfig(paragraph) {
    const text = (paragraph || '').trim() || '';
    try {
      const path = getConfigPath();
      const raw = existsSync(path) ? readFileSync(path, 'utf8') : '{}';
      const config = raw.trim() ? JSON.parse(raw) : {};
      config.bio = text;
      writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
    } catch (err) {
      console.error('[bio] save failed:', err.message);
    }
    if (text) {
      try {
        ensureStateDir();
        const whoAmIPath = join(getWorkspaceDir(), WHO_AM_I_MD);
        writeFileSync(whoAmIPath, text, 'utf8');
      } catch (err) {
        console.error('[bio] could not write WhoAmI.md:', err.message);
      }
    }
  }

  const BIO_CONFIRM_PROMPT = "Hey, we haven't done some basic setup. Do you want to do it now?";
  const BIO_PROMPT =
    "Before we continue — I'd like to know you a bit. Please answer in one message (any format is fine):\n\nWhat is my name?\nWhat is your name?\nWho am I?\nWho are you?";

  function isYesReply(text) {
    const t = (text || '').trim().toLowerCase();
    return /^(y|yes|yeah|yep|sure|ok|okay|1|do it|please|go ahead|sounds good)$/.test(t) || t === 'yup';
  }

  /** Persist config.bio to WhoAmI.md once when workspace has no identity files (same behavior as before shared prompt). */
  function ensureBioPersistedToWhoAmI() {
    if (readWorkspaceMd(WHO_AM_I_MD) || readWorkspaceMd(MY_HUMAN_MD)) return;
    const bio = getBioFromConfig();
    const bioText = typeof bio === 'string' && (bio || '').trim() ? bio.trim() : null;
    if (!bioText) return;
    try {
      ensureStateDir();
      const whoAmIPath = join(getWorkspaceDir(), WHO_AM_I_MD);
      if (!existsSync(whoAmIPath)) writeFileSync(whoAmIPath, bioText, 'utf8');
    } catch (_) {}
  }

  function buildSystemPrompt(opts = {}) {
    const agentId = (opts.agentId && String(opts.agentId).trim()) || DEFAULT_AGENT_ID;
    const forGroup = !!opts.groupSenderName;
    const groupJid = opts.groupJid || 'default';
    if (forGroup) {
      console.log('[path] buildSystemPrompt branch=group groupJid=', groupJid, 'agentId=', agentId);
      ensureGroupConfigFor(groupJid);
    } else {
      console.log('[path] buildSystemPrompt branch=one-on-one agentId=', agentId);
      ensureSoulMd();
      ensureBioPersistedToWhoAmI();
      return buildOneOnOneSystemPrompt(getAgentWorkspaceDir(agentId));
    }
    const basePrompt = buildOneOnOneSystemPrompt(getAgentWorkspaceDir(agentId));
    const loaded = loadGroupMd(getWorkspaceDir(), DEFAULT_WORKSPACE_DIR);
    const groupBlock = buildGroupPromptBlock(loaded, {
      groupSenderName: opts.groupSenderName,
      groupMentioned: !!opts.groupMentioned,
      groupNonOwner: !!opts.groupNonOwner,
    });
    console.log('[path] buildSystemPrompt groupBlockLen=', (groupBlock || '').length, 'basePromptLen=', basePrompt.length);
    return groupBlock ? (basePrompt + '\n\n' + groupBlock) : basePrompt;
  }

  /** Remove em-dash glyphs from outbound assistant text before sending. */
  function sanitizeOutboundText(text) {
    if (text == null) return '';
    return String(text)
      .replace(/\s*—\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  async function runAgentWithSkills(sock, jid, text, lastSentByJidMap, selfJidForCron, ourSentIdsRef, bioOpts = {}) {
    let skillsCalled = [];
    console.log('[agent] handling:', text.slice(0, 50) + (text.length > 50 ? '…' : ''));
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (_) {}
    const isGroupJid = isTelegramGroupJid(jid) || isWhatsAppGroupJid(jid);
    const logJid = isGroupJid ? jid : toLogJid(jid);
    const sessionLogKey = String(logJid || jid).trim();
    const { sessionId, rotated: sessionRotated } = ensureChatSession(sessionLogKey, { userText: text });
    if (sessionRotated) clearInMemoryHistoryForJids(jid, logJid, sessionLogKey);
    if (!isGroupJid) {
      await beforeUserMessage(getWorkspaceDir(), logJid, sessionId, text);
    }
    const workspaceDirForBootstrap = getWorkspaceDir();
    const sessionBootstrap =
      sessionRotated
        ? buildSessionBootstrapContext(workspaceDirForBootstrap, { logJid: isGroupJid ? undefined : logJid }).block
        : '';
    const agentId = (bioOpts.agentIdOverride && String(bioOpts.agentIdOverride).trim())
      || (isGroupJid ? resolveAgentIdForGroup(jid) : DEFAULT_AGENT_ID);
    console.log('[path] chat=', isGroupJid ? 'group' : 'one-on-one', 'jid=', jid, 'agentId=', agentId);
    const ctx = {
      storePath: getCronStorePath(),
      jid,
      sock,
      workspaceDir: getWorkspaceDir(),
      agentId,
      scheduleOneShot,
      startCron: () => startCron({ sock, selfJid: selfJidForCron, storePath: getCronStorePath(), telegramBot: telegramBot || undefined }),
      groupNonOwner: !!bioOpts.groupNonOwner,
      isGroup: isGroupJid,
      // Agent-to-agent (agent-send): group runs never get it (blocked in executor/loader).
      runInternalAgent: isGroupJid ? undefined : runInternalAgentTurn,
      agentDepth: 0,
      agentCallChain: [agentId],
      onExchange: bioOpts.logExchange,
    };
    ctx.spawnBackgroundTask = (opts) => spawnBackgroundTask({ ...opts, ctx });
    const isGroupNonOwner = !!bioOpts.groupNonOwner;
    // Step 1: cheap config-only skill ID list (no SKILL.md reads yet).
    const groupJidForSkills = isGroupJid ? jid : undefined;
    const enabledSkillIds = getEnabledSkillIds({ groupJid: groupJidForSkills, agentId });
    const enabledSkillSummaries = getEnabledSkillSummaries({ groupJid: groupJidForSkills, agentId });
    // Step 2: intent planner — one small LLM call before loading any tool schemas.
    const intentPlan = enabledSkillIds.length > 0
      ? await planIntent({ userText: text, availableSkillIds: enabledSkillIds, availableSkillSummaries: enabledSkillSummaries, agentId })
      : null;
    if (intentPlan) console.log('[intent-planner]', JSON.stringify(intentPlan));
    // Step 3: load tool schemas based on what the planner returned.
    //   intentPlan === null      → planner failed  → full tools (safe fallback)
    //   intentPlan.skills = []   → planner: chat   → skip schema loading entirely, no tools
    //   intentPlan.skills = [...] → planner: tools  → load only selected schemas
    const plannerSaysNoTools = intentPlan !== null && Array.isArray(intentPlan.skills) && intentPlan.skills.length === 0;
    let skillContext = null;
    let toolsForRequest = [];
    if (!plannerSaysNoTools) {
      skillContext = getSkillContext({ groupJid: groupJidForSkills, agentId, hintSkills: intentPlan?.skills ?? null });
      toolsForRequest = Array.isArray(skillContext.runSkillTool) && skillContext.runSkillTool.length > 0
        ? skillContext.runSkillTool
        : [];
    }
    const toolNames = toolsForRequest.map((t) => t?.function?.name).filter(Boolean);
    console.log(
      '[path] plannerMode=', intentPlan?.mode ?? 'fallback',
      plannerSaysNoTools ? 'noTools(chat)' : ('toolsCount=' + toolsForRequest.length),
      toolNames.length ? 'tools=' + toolNames.join(',') : '',
    );
    const systemPromptOpts = isGroupNonOwner
      ? {
          groupSenderName: bioOpts.groupSenderName,
          groupJid: jid,
          groupMentioned: !!bioOpts.groupMentioned,
          groupNonOwner: true,
          agentId,
        }
      : { groupSenderName: bioOpts.groupSenderName, agentId };
    const inMemoryHistory = getLast5ExchangesForSession(jid, sessionId);
    const historyMessages = isGroupJid
      ? readLastGroupExchanges(getWorkspaceDir(), jid, MAX_CHAT_HISTORY_EXCHANGES, sessionId)
      : (inMemoryHistory.length > 0
          ? inMemoryHistory
          : readLastPrivateExchanges(getWorkspaceDir(), logJid, MAX_CHAT_HISTORY_EXCHANGES, sessionId));
    const systemPrompt = buildSystemPrompt(systemPromptOpts);
    const planBlock = intentPlanToSystemBlock(intentPlan);
    let systemPromptWithPlan = planBlock ? systemPrompt + '\n\n' + planBlock : systemPrompt;
    if (sessionBootstrap) systemPromptWithPlan += sessionBootstrap;
    if (!isGroupJid) {
      const memoryConfig = getMemoryConfig();
      const retroBlock = await buildRetrospectiveContextBlock(text, memoryConfig);
      if (retroBlock) systemPromptWithPlan += retroBlock;
    }
    const llmOptions = agentId ? { agentId } : {};
    console.log('[path] runAgentTurn systemPromptLen=', systemPromptWithPlan.length, 'toolsCount=', toolsForRequest.length);
    const turnResult = await runAgentTurn({
      userText: text,
      ctx,
      systemPrompt: systemPromptWithPlan,
      tools: toolsForRequest,
      historyMessages,
      getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
      resolveToolName: skillContext?.resolveToolName ?? (() => null),
    });
    let resultToUse = turnResult;
    let skillsCalledFromTurn = Array.isArray(turnResult?.skillsCalled) && turnResult.skillsCalled.length ? turnResult.skillsCalled : [];
    const hasSearchOrBrowse = (arr) => Array.isArray(arr) && (arr.includes('search') || arr.includes('browse'));
    const hasSearchOrBrowseTool = toolsForRequest.some(
      (t) => t?.function?.name?.startsWith('search_') || t?.function?.name === 'browse_navigate',
    );
    const firstReply = sanitizeOutboundText((turnResult?.textToSend || '').trim());
    const firstTextForSend = isTelegramChatId(jid) ? firstReply.replace(/^\[CowCode\]\s*/i, '').trim() : firstReply;
    if (
      (hasSearchOrBrowseTool || plannerSaysNoTools) &&
      !hasSearchOrBrowse(skillsCalledFromTurn) &&
      skillsCalledFromTurn.length === 0 &&
      firstTextForSend
    ) {
      // Ask the LLM whether the answer is actually complete before deciding to retry.
      // This replaces the old structural check (no tools called = uncertain) which fired
      // for greetings, jokes, and any direct answer that legitimately needed no tools.
      let needsSearch = false;
      try {
        const probeReply = await llmChat([
          { role: 'system', content: 'You are a quality checker. Answer only with valid JSON, no prose.' },
          {
            role: 'user',
            content:
              `User asked: "${text.slice(0, 300)}"\n\nAssistant answered: "${firstTextForSend.slice(0, 300)}"\n\n` +
              `Does the answer fully address the user's question, or does it need real-time / current information from a web search to be complete?\n` +
              `Reply with exactly one of:\n{ "complete": true }\n{ "complete": false }`,
          },
        ], llmOptions);
        const probe = JSON.parse(stripThinking(probeReply || '').trim());
        needsSearch = probe?.complete === false;
      } catch (_) {}

      if (needsSearch) {
        // For plannerSaysNoTools: lazily load the full skill context now so the retry has all tools.
        // For normal path: reuse existing skillContext with the already-loaded tools.
        const retrySkillContext = skillContext ?? getSkillContext({ groupJid: groupJidForSkills, agentId });
        const retryTools = Array.isArray(retrySkillContext?.runSkillTool) ? retrySkillContext.runSkillTool : toolsForRequest;
        const retryLabel = plannerSaysNoTools ? '[Retry with tools]' : '[Retry with search]';
        const retryInstruction = plannerSaysNoTools
          ? `${retryLabel} The user asked: "${text.slice(0, 500)}${text.length > 500 ? '…' : ''}". Use available tools to look up the specific or current information needed, then reply with what you find.`
          : `${retryLabel} The user asked: "${text.slice(0, 500)}${text.length > 500 ? '…' : ''}". Use the search skill (or browse if they gave a URL) to look up current information, then reply with what you find.`;
        console.log('[agent] LLM probe: answer incomplete, retrying —', retryLabel);
        try {
          const retryResult = await runAgentTurn({
            userText: retryInstruction,
            ctx,
            systemPrompt: systemPromptWithPlan,
            tools: retryTools,
            historyMessages,
            getFullSkillDoc: retrySkillContext?.getFullSkillDoc ?? (() => ''),
            resolveToolName: retrySkillContext?.resolveToolName ?? (() => null),
          });
          const retryUsedTools = Array.isArray(retryResult?.skillsCalled) && retryResult.skillsCalled.length > 0;
          if (retryResult?.textToSend?.trim() && (hasSearchOrBrowse(retryResult.skillsCalled) || (plannerSaysNoTools && retryUsedTools))) {
            resultToUse = retryResult;
            skillsCalledFromTurn = retryResult.skillsCalled ?? skillsCalledFromTurn;
          }
        } catch (err) {
          console.error('[agent] retry failed:', getErrorMessageForLog(err));
        }
      }
    }
    const { textToSend, voiceReplyText, imageReplyPath, imageReplyCaption, skillsCalled: called } = resultToUse || {};
    if (Array.isArray(called) && called.length) skillsCalled = called;
    const cleanedTextToSend = sanitizeOutboundText(textToSend || '');
    const cleanedVoiceReplyText = sanitizeOutboundText(voiceReplyText || '');
    const textForSend = isTelegramChatId(jid) ? cleanedTextToSend.replace(/^\[CowCode\]\s*/i, '').trim() : cleanedTextToSend;
    const isGroupNoReply = bioOpts.groupNonOwner && !bioOpts.groupMentioned &&
      !(cleanedVoiceReplyText && cleanedVoiceReplyText.trim()) &&
      (!textForSend || !textForSend.trim() || /^\[NO_REPLY\]\s*$/i.test(textForSend.trim()));
    if (!isGroupNoReply) {
      let voiceBuffer = null;
      let imageBuffer = null;
      if (imageReplyPath && existsSync(imageReplyPath)) {
        try {
          imageBuffer = readFileSync(imageReplyPath);
        } catch (err) {
          console.error('[vision] read image failed:', err.message);
        }
      }
      const forceVoiceReply = !!bioOpts.forceVoiceReply;
      const textForVoice = (cleanedVoiceReplyText && cleanedVoiceReplyText.trim())
        ? cleanedVoiceReplyText.trim()
        : ((forceVoiceReply && textForSend && textForSend.trim()) ? textForSend.trim() : null);
      if (textForVoice && !imageBuffer) {
        try {
          const speechConfig = getSpeechConfig();
          if (speechConfig?.elevenLabsApiKey) {
            voiceBuffer = await synthesizeToBuffer(speechConfig.elevenLabsApiKey, textForVoice, speechConfig.defaultVoiceId);
          }
        } catch (err) {
          console.error('[speech] synthesize failed:', err.message);
        }
      }
      const replyText = (cleanedVoiceReplyText && cleanedVoiceReplyText.trim()) ? cleanedVoiceReplyText.trim() : textForSend;
      const captionForImage = (replyText && replyText.trim()) ? replyText.replace(/^\[CowCode\]\s*/i, '').trim() : (imageReplyCaption || '');
      try {
        let sent;
        if (voiceBuffer) {
          sent = await sock.sendMessage(jid, isTelegramChatId(jid) ? { voice: voiceBuffer } : { audio: voiceBuffer, ptt: true });
        } else if (imageBuffer) {
          sent = await sock.sendMessage(jid, isTelegramChatId(jid)
            ? { image: imageBuffer, caption: captionForImage }
            : { image: imageBuffer, caption: captionForImage, mimetype: 'image/png' });
        } else {
          sent = await sock.sendMessage(jid, { text: replyText });
        }
        if (sent?.key?.id && ourSentIdsRef?.current) {
          ourSentIdsRef.current.add(sent.key.id);
          if (ourSentIdsRef.current.size > MAX_OUR_SENT_IDS) {
            const first = ourSentIdsRef.current.values().next().value;
            if (first) ourSentIdsRef.current.delete(first);
          }
        }
        lastSentByJidMap.set(jid, replyText);
        pushExchange(jid, text, replyText, sessionId);
        const ts = Date.now();
        // Storage uses logJid (owner-unified for owner DMs); routing already used `jid`.
        const exchange = { user: text, assistant: replyText, timestampMs: ts, jid: logJid, sessionId };
        if (bioOpts.logExchange) {
          bioOpts.logExchange(exchange);
        } else {
          if (isGroupJid) {
            try {
              appendGroupExchange(getWorkspaceDir(), jid, exchange);
            } catch (err) {
              console.error('[group-chat-log] write failed:', err.message);
            }
          } else {
            const memoryConfig = getMemoryConfig();
            let logMeta = null;
            if (memoryConfig) {
              const indexPromise = indexChatExchange(memoryConfig, exchange).then((meta) => {
                logMeta = meta;
                afterExchangeLogged(getWorkspaceDir(), exchange, logMeta);
              }).catch((err) =>
                console.error('[memory] auto-index failed:', err.message)
              );
              if (process.argv.includes('--test')) await indexPromise;
            } else {
              const out = appendExchange(getWorkspaceDir(), exchange);
              logMeta = out;
              afterExchangeLogged(getWorkspaceDir(), exchange, logMeta);
            }
          }
        }
        console.log('[replied]', toolsForRequest.length > 0 ? '(agent + skills)' : '(chat)');
        console.log('[replied] question:', text);
        const partialLen = 300;
        console.log('[replied] answer (partial):', (replyText || '').slice(0, partialLen) + ((replyText || '').length > partialLen ? '…' : ''));
        if (Array.isArray(skillsCalled) && skillsCalled.length > 0) {
          console.log('[replied] skills called:', skillsCalled.join(', '));
        }
        if (!isGroupJid || isTelegramGroupJid(jid)) scheduleTideFollowUp(jid);
        const alreadySentBioPrompt = bioOpts.bioPromptSentJids?.has(jid);
        if (bioOpts.pendingBioConfirmJids != null && !isBioSet() && !alreadySentBioPrompt) {
          try {
            await sock.sendMessage(jid, { text: BIO_CONFIRM_PROMPT });
            bioOpts.pendingBioConfirmJids.add(jid);
            bioOpts.bioPromptSentJids?.add(jid);
          } catch (_) {
            if (isTelegramChatId(jid)) addPendingTelegram(jid, BIO_CONFIRM_PROMPT);
            else pendingReplies.push({ jid, text: BIO_CONFIRM_PROMPT });
            bioOpts.pendingBioConfirmJids.add(jid);
            bioOpts.bioPromptSentJids?.add(jid);
          }
        }
      } catch (sendErr) {
        lastSentByJidMap.set(jid, replyText); // E2E can still assert on intended reply when send fails
        const errMsg = getErrorMessageForLog(sendErr);
        if (!isTelegramChatId(jid)) {
          pendingReplies.push({ jid, text: replyText });
          console.log('[replied] queued (send failed, will retry after reconnect):', errMsg);
        } else {
          addPendingTelegram(jid, replyText);
          console.log('[replied] Telegram queued (send failed, will retry on next message):', errMsg);
        }
        if (!isGroupJid || isTelegramGroupJid(jid)) scheduleTideFollowUp(jid);
      }
    }
  return { skillsCalled: skillsCalled || [] };
  }

  // --test / --test-group: run main code path once with mock socket (set above), then exit. No WhatsApp auth.
  // E2E tests capture stdout and parse E2E_REPLY_START...E2E_REPLY_END to assert on the reply.
  const testGroupMode = process.argv.includes('--test-group');
  if (process.argv.includes('--test') || testGroupMode) {
    const testFlag = testGroupMode ? '--test-group' : '--test';
    const testIdx = process.argv.indexOf(testFlag);
    const argValue = (flag, fallback = '') => {
      const idx = process.argv.indexOf(flag);
      if (idx === -1) return fallback;
      const next = process.argv[idx + 1];
      if (!next || String(next).startsWith('--')) return fallback;
      return next;
    };
    const testMsg1 = process.argv[testIdx + 1] || process.env.TEST_MESSAGE || 'Send me hello in 1 minute';
    const testMsg2 = process.env.TEST_MESSAGE_2;
    const testAgentId = argValue('--test-agent', '');
    const testJid = testGroupMode
      ? argValue('--test-jid', '-1003722613696')
      : argValue('--test-jid', 'test@s.whatsapp.net');
    const testSender = argValue('--test-sender', 'Test Group User');
    const lastSent = new Map();
    const sentIds = { current: new Set() };
    for (const [i, testMsg] of [testMsg1, testMsg2].filter(Boolean).entries()) {
      console.log('[test] Running', testGroupMode ? 'group' : 'one-on-one', 'code path with message', i + 1 + ':', testMsg.slice(0, 60));
      let runRet = { skillsCalled: [] };
      try {
        runRet = await runAgentWithSkills(sock, testJid, testMsg, lastSent, testJid, sentIds, {
          ...(testGroupMode
            ? { groupNonOwner: true, groupSenderName: testSender, groupMentioned: true }
            : {}),
          ...(testAgentId ? { agentIdOverride: testAgentId } : {}),
        }) || runRet;
      } catch (err) {
        lastSent.set(testJid, 'Moo — ' + (err && err.message ? err.message : String(err)));
      }
      const reply = lastSent.get(testJid);
      if (reply != null && (testMsg2 ? (i === 1) : true)) {
        if (Array.isArray(runRet.skillsCalled) && runRet.skillsCalled.length) {
          console.log('E2E_SKILLS_CALLED: ' + runRet.skillsCalled.join(','));
        }
        console.log('E2E_REPLY_START');
        process.stdout.write(reply + '\n');
        console.log('E2E_REPLY_END');
      }
    }
    console.log('[test] Done. Check cron/jobs.json.');
    process.exit(0);
  }

  // Telegram-only mode: no WhatsApp; run only Telegram bot and cron.
  if (telegramOnlyMode) {
    const telegramToken = channelsConfig.telegram.botToken;
    const telegramBot = initBot(telegramToken);
    const telegramSock = createTelegramSock(telegramBot);
    sock = telegramSock; // Tide needs sock for transport; in Telegram-only this is the Telegram sock
    console.log('');
    console.log('  ─────────────────────────────────────────');
    console.log('  Running in Telegram-only mode');
    console.log('  ─────────────────────────────────────────');
    console.log('');
    runBot(telegramSock, { telegramOnly: true, telegramBot });
    return;
  }

  async function runBot(sock, opts = {}) {
    console.log('[tide] runBot entered');
    const { telegramOnly, telegramBot: optsTelegramBot } = opts;
    if (telegramOnly && optsTelegramBot) {
      telegramBot = optsTelegramBot;
      writeDaemonStarted();
      startCron({ storePath: getCronStorePath(), telegramBot: optsTelegramBot });
      startTide(sock, null);
      startRetrospective();
      const lastSentByJid = new Map();
      const ourSentMessageIds = new Set();
      const telegramRepliedIds = new Set();
      const pendingBioJids = new Set();
      const pendingBioConfirmJids = new Set();
      const bioPromptSentJidsTelegram = new Set();
      const MAX_TELEGRAM_REPLIED = 500;
      const telegramCtx = {
        bot: optsTelegramBot,
        sock,
        getChannelsConfig,
        getSpeechConfig,
        getUploadsDir,
        transcribe,
        clearPendingTelegram,
        flushPendingTelegram: (chatId) => flushPending(chatId, optsTelegramBot),
        addPendingTelegram,
        getOwnerConfig,
        isOwner,
        pendingBioConfirmJids,
        pendingBioJids,
        bioPromptSentJids: bioPromptSentJidsTelegram,
        saveBioToConfig,
        telegramRepliedIds,
        MAX_TELEGRAM_REPLIED,
        resetBrowseSession,
        runPastDueOneShots,
        runAgentWithSkills,
        lastSentByJid,
        ourSentMessageIds,
        getMemoryConfig,
        indexChatExchange,
        getWorkspaceDir,
        toUserMessage,
        getBotUsername: createGetBotUsername(optsTelegramBot),
        getGroupPromptMessages: () => loadGroupMd(getWorkspaceDir(), DEFAULT_WORKSPACE_DIR).messages,
      };
      optsTelegramBot.on('message', async (msg) => {
        if (isTelegramGroup(msg.chat)) {
          await handleTelegramGroupMessage(msg, telegramCtx);
        } else {
          await handleTelegramPrivateMessage(msg, telegramCtx);
        }
      });
      return;
    }

    console.log('');
    console.log('  ─────────────────────────────────────────');
    console.log('  Connecting to WhatsApp');
    console.log('  ─────────────────────────────────────────');
    console.log('');

    let telegramSock = null;
    const telegramToken = getChannelsConfig().telegram.botToken;
    // Only init and log Telegram when configured; when not set up we don't show or log anything about Telegram.
    if (telegramToken) {
      telegramBot = initBot(telegramToken);
      telegramSock = createTelegramSock(telegramBot);
      console.log('  Telegram bot enabled.');
      console.log('[tide] Calling startTide (Telegram path)');
      startTide(telegramSock, null);
      startRetrospective();
    }

    sock.ev.on('connection.update', (u) => {
    if (u.connection === 'open') {
      whatsappSockRef.current = sock;
      console.log('  [connection] connection successful');
      writeDaemonStarted();
      const sid = sock.user?.id ?? selfJid;
      if (sid) selfJid = sid;
      console.log('  WhatsApp connected. Message your own number to start chatting.');
      console.log('');
      if (sid) {
        startCron({ sock, selfJid: sid, storePath: getCronStorePath(), telegramBot: telegramBot || undefined });
        startTide(sock, sid);
        startRetrospective();
      }
      // Flush replies that failed to send while disconnected
      while (pendingReplies.length > 0) {
        const { jid, text } = pendingReplies.shift();
        sock.sendMessage(jid, { text }).catch((e) => console.error('[pending] send failed:', e.message));
      }
    }
    if (u.connection === 'close') {
      whatsappSockRef.current = null;
      stopCron();
      stopTide();
      const reason = u.lastDisconnect?.error;
      const code = reason?.output?.statusCode ?? reason?.statusCode;
      const msg = reason?.message || reason?.output?.payload?.message;
      const why = DISCONNECT_REASONS[code] || (code != null ? `Code ${code}` : 'unknown');
      console.log('WhatsApp disconnected:', why);
      if (msg) console.log('  →', msg);
      if (code === 401 || code === 403 || code === 428) {
        console.log('  → Run: pnpm run auth   to re-link your device.');
      }
      if (typeof opts.onDisconnect === 'function') opts.onDisconnect(code);
    }
  });

  // Message flow: intercept incoming → immediate reply → schedule/LLM in background.
  let selfJid = sock.user?.id;
  sock.ev.on('creds.update', () => { selfJid = sock.user?.id; });
  const repliedIds = new Set();
  const lastSentByJid = new Map();
  const ourSentMessageIds = new Set(); // IDs of messages we sent (to ignore echo in self-chat)
  const pendingBioJids = new Set();
  const pendingBioConfirmJids = new Set();
  const bioPromptSentJids = new Set(); // only send setup prompt once per chat

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages ?? []) {
      if (!m.key?.remoteJid) continue;
      if (isJidBroadcast(m.key.remoteJid)) continue;

      selfJid = selfJid ?? sock.user?.id;
      const jid = m.key.remoteJid;

      // Group handling only on Telegram; ignore WhatsApp group messages.
      if (isWhatsAppGroupJid(jid)) continue;

      // Only respond in self-chat (saved messages): from us and chat is with ourselves. Ignore all other chats.
      if (!m.key.fromMe) continue;
      if (!selfJid || !areJidsSameUser(jid, selfJid)) continue;

      const content = extractMessageContent(m.message);
      let userText = (content?.conversation || content?.extendedTextMessage?.text || '').trim();
      let userSentVoice = false;
      if (!userText && content?.imageMessage) {
        try {
          const buf = await downloadMediaMessage(m, 'buffer', {});
          const uploadsDir = getUploadsDir();
          if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
          const msgId = m.key?.id || Date.now();
          const imagePath = join(uploadsDir, `image-${msgId}.jpg`);
          writeFileSync(imagePath, buf);
          const caption = (content.imageMessage.caption || '').trim();
          userText = `User sent an image. Image file: ${imagePath}. ${caption ? 'Caption: ' + caption : "What's in this image?"}`;
        } catch (err) {
          console.error('[image] download failed:', err.message);
          continue;
        }
      }
      if (!userText && content?.audioMessage) {
        try {
          const speechConfig = getSpeechConfig();
          if (speechConfig?.whisperApiKey) {
            const buf = await downloadMediaMessage(m, 'buffer', {});
            const uploadsDir = getUploadsDir();
            if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
            const msgId = m.key?.id || Date.now();
            const ext = (content.audioMessage.mimetype || '').includes('ogg') ? 'ogg' : 'm4a';
            const audioPath = join(uploadsDir, `voice-${msgId}.${ext}`);
            writeFileSync(audioPath, buf);
            userText = await transcribe(speechConfig.whisperApiKey, audioPath);
            if (userText && userText.trim()) userSentVoice = true;
          }
        } catch (err) {
          console.error('[voice] transcribe failed:', err.message);
        }
      }
      if (!userText) continue;

      // Do not treat our own CowCode replies as user input.
      if (userText.startsWith('[CowCode]')) continue;

      // Skip only when this is clearly our echo: fromMe and the text exactly matches what we last sent to this chat.
      const lastWeSent = lastSentByJid.get(jid);
      if (m.key.fromMe && typeof lastWeSent === 'string' && userText === lastWeSent) {
        console.log('[skip] our echo (fromMe, text matches last sent)');
        continue;
      }

      const msgKey = m.key.id ? `${jid}:${m.key.id}` : null;
      if (msgKey && repliedIds.has(msgKey)) {
        console.log('[skip] already replied to this message id');
        continue;
      }
      if (msgKey) {
        repliedIds.add(msgKey);
        if (repliedIds.size > MAX_REPLIED_IDS) {
          const first = repliedIds.values().next().value;
          if (first) repliedIds.delete(first);
        }
      }

      if (pendingBioConfirmJids.has(jid)) {
        pendingBioConfirmJids.delete(jid);
        if (isYesReply(userText)) {
          try {
            await sock.sendMessage(jid, { text: BIO_PROMPT });
            pendingBioJids.add(jid);
          } catch (e) {
            pendingReplies.push({ jid, text: BIO_PROMPT });
            pendingBioJids.add(jid);
          }
        } else {
          const noThanks = "No problem. You can do it later from setup.";
          try {
            await sock.sendMessage(jid, { text: noThanks });
          } catch (e) {
            pendingReplies.push({ jid, text: noThanks });
          }
        }
        continue;
      }

      if (pendingBioJids.has(jid)) {
        saveBioToConfig(userText);
        pendingBioJids.delete(jid);
        const thanks = "Thanks, I've saved that.";
        try {
          await sock.sendMessage(jid, { text: thanks });
        } catch (e) {
          pendingReplies.push({ jid, text: thanks });
        }
        continue;
      }

      if (userText.trim().toLowerCase() === '/browse-reset') {
        await resetBrowseSession({ jid });
        const reply = 'Browser reset. Next browse will start fresh.';
        try {
          await sock.sendMessage(jid, { text: reply });
        } catch (e) {
          pendingReplies.push({ jid, text: reply });
        }
        continue;
      }

      if (userText.trim().toLowerCase() === '/tasks') {
        const reply = formatTasksList(jid);
        try {
          await sock.sendMessage(jid, { text: reply });
        } catch (e) {
          pendingReplies.push({ jid, text: reply });
        }
        continue;
      }

      if (userSentVoice && userText) {
        userText += '\n\n[The user sent a voice message. Reply using the speech skill with action reply_as_voice so your reply is sent as a voice message. Keep your reply conversational and spoken-word friendly: summarize, answer, or respond naturally. Do NOT read out file names, folder names, long paths, or raw file contents unless the user explicitly asks for them.]';
      }

      console.log('[incoming]', userText.slice(0, 60) + (userText.length > 60 ? '…' : ''));
      try {
        await runPastDueOneShots().catch((e) => console.error('[cron] runPastDueOneShots:', e.message));
        if (m.key.id) {
          try {
            await sock.readMessages([{ remoteJid: jid, id: m.key.id, participant: m.key.participant, fromMe: false }]);
          } catch (_) {}
        }

        runAgentWithSkills(sock, jid, userText, lastSentByJid, selfJid ?? sock.user?.id, { current: ourSentMessageIds }, {
          pendingBioJids,
          pendingBioConfirmJids,
          bioPromptSentJids,
          forceVoiceReply: userSentVoice,
        }).catch((err) => {
          console.error('Background agent error:', err.message);
          const errorText = '[CowCode] Moo — ' + toUserMessage(err);
          sock.sendMessage(jid, { text: errorText }).catch(() => {
            pendingReplies.push({ jid, text: errorText });
          });
        });
      } catch (err) {
        console.error('LLM error:', err.message);
        const errorText = '[CowCode] Moo — ' + toUserMessage(err);
        try {
          await sock.sendMessage(jid, { text: errorText });
        } catch (_) {
          pendingReplies.push({ jid, text: errorText });
        }
      }
    }
  });

  if (telegramSock && telegramBot) {
    const telegramRepliedIds = new Set();
    const MAX_TELEGRAM_REPLIED = 500;
    const telegramCtx = {
      bot: telegramBot,
      sock: telegramSock,
      getChannelsConfig,
      getSpeechConfig,
      getUploadsDir,
      transcribe,
      clearPendingTelegram,
      flushPendingTelegram: (chatId) => flushPending(chatId, telegramBot),
      addPendingTelegram,
      getOwnerConfig,
      isOwner,
      pendingBioConfirmJids,
      pendingBioJids,
      bioPromptSentJids,
      saveBioToConfig,
      telegramRepliedIds,
      MAX_TELEGRAM_REPLIED,
      resetBrowseSession,
      formatTasksList,
      runPastDueOneShots,
      runAgentWithSkills,
      lastSentByJid,
      ourSentMessageIds,
      getMemoryConfig,
      indexChatExchange,
      getWorkspaceDir,
      toUserMessage,
      getBotUsername: createGetBotUsername(telegramBot),
      getGroupAddedBy,
      getGroupPromptMessages: () => loadGroupMd(getWorkspaceDir(), DEFAULT_WORKSPACE_DIR).messages,
    };
    let cachedTelegramBotUserId = null;
    async function getTelegramBotUserId() {
      if (cachedTelegramBotUserId != null) return cachedTelegramBotUserId;
      try {
        const me = await telegramBot.getMe();
        cachedTelegramBotUserId = me?.id ?? null;
      } catch {
        cachedTelegramBotUserId = null;
      }
      return cachedTelegramBotUserId;
    }
    telegramBot.on('message', async (msg) => {
      if (isTelegramGroup(msg.chat)) {
        const chatId = msg.chat?.id;
        const newMembers = msg.new_chat_members;
        if (chatId != null && Array.isArray(newMembers) && newMembers.length > 0 && msg.from?.id != null) {
          const botUserId = await getTelegramBotUserId();
          if (botUserId != null && newMembers.some((u) => u?.id === botUserId || (u?.is_bot && String(u?.id) === String(botUserId)))) {
            setGroupAddedBy(chatId, msg.from.id);
          }
        }
        await handleTelegramGroupMessage(msg, telegramCtx);
      } else {
        await handleTelegramPrivateMessage(msg, telegramCtx);
      }
    });
  }
  }

  // Telegram-only or test: single run, no reconnect
  if (telegramOnlyMode || process.argv.includes('--test')) {
    runBot(sock, {});
    return;
  }

  // Need-auth path: single run after QR/pairing
  if (needAuth) {
    runBot(sock, {});
    return;
  }

  // Normal path: connect with retry and reconnect loop
  let reconnectAttempt = 0;
  while (true) {
    let s;
    try {
      s = await connectWhatsApp();
    } catch (e) {
      const code = e.code != null ? Number(e.code) : null;
      if (code !== null && NO_RETRY_CODES.has(code)) {
        console.log('Cannot reconnect (logged out or forbidden). Run: pnpm run auth');
        process.exit(1);
      }
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt++;
      console.log('Connection failed. Reconnecting in', Math.round(delay / 1000), 's...');
      await sleep(delay);
      continue;
    }
    reconnectAttempt = 0;
    const disconnectPromise = new Promise((resolve) => {
      runBot(s, { onDisconnect: (code) => resolve({ code }) });
    });
    const { code } = await disconnectPromise;
    if (code !== null && code !== undefined && NO_RETRY_CODES.has(code)) {
      console.log('Logged out or forbidden. Run: pnpm run auth');
      break;
    }
    const delay = RECONNECT_DELAYS_MS[0];
    console.log('Reconnecting in', Math.round(delay / 1000), 's...');
    await sleep(delay);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
