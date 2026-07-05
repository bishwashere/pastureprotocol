/**
 * WhatsApp + configurable LLM. On incoming message → LLM reply → send back.
 * Config and state live in ~/.pasture (or PASTURE_STATE_DIR).
 */

import { getAuthDir, getCronStorePath, getConfigPath, getEnvPath, ensureStateDir, getWorkspaceDir, getUploadsDir, getStateDir, getAgentWorkspaceDir, getAgentsDir, getMemoryIndexPath } from './lib/util/paths.js';
import { beginCliSession } from './lib/util/cli-banner.js';
import dotenv from 'dotenv';

dotenv.config({ path: getEnvPath() });

// Log to daemon.log so "tail -f" shows when the process actually started (after pasture start/restart)
console.log(`[${new Date().toISOString().replace(/\.\d{3}Z$/, '')}] Pasture Protocol daemon started`);

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
import { loadConfig, chat as llmChat, isDailyLimitReached, msUntilLimitResets } from './llm.js';
import { runAgentTurn, stripThinking } from './lib/agent/agent.js';
import { runInternalAgentTurn } from './lib/agent/internal-agent-turn.js';
import { onAgentTurnStart, onAgentTurnDone } from './lib/agent/agent-context-state.js';
import { routeTurn, turnRouteToSystemBlock, buildCasualChatTurnRoute } from './lib/agent/turn-router.js';
import { classifyTurnIntent, buildCasualPlanFromTurnIntent } from './lib/agent/turn-intent.js';
import { classifySelfInspection, buildSelfInspectionIntentPlan } from './lib/agent/self-inspection.js';
import { isNonTaskMessage } from './lib/agent/evaluate-team-capability.js';
import { syncMainAgentIdentityFromWorkspace } from './lib/agent/identity-sync.js';
import { buildDelegationContext } from './lib/agent/agent-delegation-router.js';
import { buildDelegationDecisionDetails } from './lib/agent/delegation-routing-details.js';
import { executeSkill } from './skills/executor.js';
import { logTeamActivity } from './lib/agent/team-activity.js';
import {
  startRequestTrace,
  runWithRequestTrace,
  logRequestStart,
  logRequestEnd,
  traceAsyncStep,
} from './lib/util/request-timing.js';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import pino from 'pino';
import { startCron, stopCron, scheduleOneShot, runPastDueOneShots } from './cron/runner.js';
import { getSkillsEnabled, getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries, DEFAULT_ENABLED } from './skills/loader.js';
import { initBot, createTelegramSock, isTelegramChatId, isTelegramGroupJid, sendLongText, ensurePollingAlive } from './lib/channels/telegram.js';
import { isWhatsAppGroupJid } from './lib/channels/whatsapp.js';
import { addPending as addPendingTelegram, clearPending as clearPendingTelegram, flushPending } from './lib/channels/pending-telegram.js';
import { getChannelsConfig } from './lib/channels/channels-config.js';
import { getSchedulingTimeContext, isInTideInactiveWindow } from './lib/util/timezone.js';
import {
  defaultTideChecklistBlock,
  shouldRunChecklistForTrigger,
  runTideChecklist,
} from './lib/agent/tide-checklist.js';
import { getOwnerConfig, isOwner } from './lib/util/owner-config.js';
import { getGroupAddedBy, setGroupAddedBy } from './lib/channels/telegram-group-added-by.js';
import { isTelegramGroup } from './lib/channels/group-guard.js';
import { getMemoryConfig } from './lib/context/memory-config.js';
import { indexChatExchange, renameIndexedChatLogPath } from './lib/context/memory-index.js';
import {
  migrateRetrospectiveConfig,
  startRetrospective,
  afterExchangeLogged,
  buildRetrospectiveContextBlock,
} from './lib/agent/retrospective.js';
import { startSystemPulse, getPendingHealthFlags, migrateSystemPulseConfig } from './lib/agent/system-pulse.js';
import { appendExchange, appendGroupExchange, getLastPrivateExchange, readLastGroupExchanges, readLastPrivateExchanges, readPrivateExchangesInWindow, resolveChatHistoryExchanges, migrateLegacyDatedChatLogs, migratePrivateChatLogFileNames } from './lib/context/chat-log.js';
import { ensureChatSession, shouldAckNewSessionOnly, NEW_SESSION_ACK, getSessionWorkMode } from './lib/context/chat-session.js';
import { resolveWorkModeForTurn } from './lib/agent/work-mode.js';
import { buildSessionBootstrapContext } from './lib/agent/session-bootstrap.js';
import {
  buildProjectsContextBlock,
  buildProjectTeamGateReply,
  enrichMessageWithProjectContext,
  getProjectTeamId,
  listProjectsForTeam,
  resolveFocusedProjectForTurn,
} from './lib/context/projects-context.js';
import { getAgentTeamId } from './lib/agent/teams.js';
import { buildMissionsContextBlock, buildMissionIntentPlan, resolveMissionForUserTurn } from './lib/context/missions-context.js';
import { buildProjectWorkflowContextBlock, syncTurnToProjectWork } from './lib/context/project-workflow.js';
import {
  buildDurabilitySystemBlock,
  buildDurableDelegationContext,
  delegationArgsFromDurability,
  delegationRoutingTextFromDurability,
  prepareWorkDurabilityWithAi,
} from './lib/context/work-durability.js';
import { buildGithubSourceIntentPlan } from './lib/context/github-context.js';
import {
  classifyTaskFrameTurn,
  clearTaskFrame,
  shouldUseTaskFrameFastPath,
  taskFrameDecisionToTurnRoute,
  taskFrameToSystemBlock,
  updateTaskFrameAfterTurn,
  upsertTaskFrame,
} from './lib/context/task-frame.js';
import { formatUserFacingReply, logOutboundReplyDecorations } from './lib/agent/user-facing-reply.js';
import { toLogJid, getOwnerLogJid } from './lib/util/owner-config.js';
import { handleTelegramPrivateMessage } from './lib/channels/telegram-private-handler.js';
import { handleTelegramGroupMessage } from './lib/channels/telegram-group-handler.js';
import { ensureGroupConfigFor } from './lib/channels/group-config.js';
import { loadGroupMd, buildGroupPromptBlock } from './lib/channels/group-prompt.js';
import { buildOneOnOneSystemPrompt } from './lib/agent/system-prompt.js';
import { ensureMainAgentInitialized, resolveAgentIdForGroup, readAgentMd, DEFAULT_AGENT_ID, buildAgentTeamPromptBlock } from './lib/agent/agent-config.js';
import { recoverStaleBackgroundTasks, formatTasksList, spawnBackgroundTask } from './lib/agent/background-tasks.js';
import { startMissionEngine } from './lib/agent/mission-engine.js';
import { configureAutonomy, maybeStartOnBoot } from './lib/agent/autonomy-gate.js';
import { getGroupDisplayName, setGroupDisplayName, parseSetDisplayNameMessage } from './lib/channels/group-display-names.js';
import { resetBrowseSession } from './lib/agent/executors/browse.js';
import { toUserMessage, getErrorMessageForLog } from './lib/util/user-error.js';
import { getSpeechConfig, transcribe, synthesizeToBuffer } from './lib/integrations/speech-client.js';
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
const _consoleError = console.error;
function tsPrefix() {
  return `[${new Date().toISOString().replace(/\.\d{3}Z$/, '')}]`;
}
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
console.log = (...args) => _consoleLog(tsPrefix(), ...redactConsoleArgs(args));
console.info = (...args) => _consoleInfo(tsPrefix(), ...redactConsoleArgs(args));
console.debug = (...args) => _consoleDebug(tsPrefix(), ...redactConsoleArgs(args));
console.warn = (...args) => _consoleWarn(tsPrefix(), ...redactConsoleArgs(args));
console.error = (...args) => _consoleError(tsPrefix(), ...redactConsoleArgs(args));

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
          console.log('Linked. You can Ctrl+C and run pasture start.');
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
  // Helper: add any missing DEFAULT_ENABLED ids to a parsed config in-place.
  // Returns true when something changed.
  const ensureDefaults = (config) => {
    const skills = config.skills || {};
    let enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
    let changed = false;
    for (const id of DEFAULT_ENABLED) {
      if (!enabled.includes(id)) {
        enabled = [...enabled, id];
        changed = true;
      }
    }
    if (changed) config.skills = { ...skills, enabled };
    return changed;
  };

  // 1) Global config — kept for backward compatibility with code paths that
  //    still read getConfigPath() directly (and as the source for
  //    ensureMainAgentInitialized when a main agent config is empty).
  try {
    const path = getConfigPath();
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      const config = JSON.parse(raw);
      if (ensureDefaults(config)) {
        writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
      }
    }
  } catch (_) {}

  // 2) Per-agent configs — these are what the runtime actually reads via
  //    loadAgentConfig() / getEnabledSkillIds(). Without this loop, a brand
  //    new default skill (e.g. `http`) added to DEFAULT_ENABLED never reaches
  //    existing agents because their skills.enabled list was forked off the
  //    global config the first time the agent was created. Walking the
  //    agents directory keeps the runtime list and DEFAULT_ENABLED in sync
  //    on every daemon start.
  try {
    const agentsDir = getAgentsDir();
    if (!existsSync(agentsDir)) return;
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cfgPath = join(agentsDir, entry.name, 'config.json');
      if (!existsSync(cfgPath)) continue;
      try {
        const raw = readFileSync(cfgPath, 'utf8');
        const config = JSON.parse(raw);
        // Only migrate agents that already opted into skills (i.e. they have a
        // skills.enabled list). Agents that fall through to the global config
        // (loadAgentConfig returns {} -> falls back to main) don't need it.
        if (!config.skills || !Array.isArray(config.skills.enabled)) continue;
        if (ensureDefaults(config)) {
          writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
        }
      } catch (_) {}
    }
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
  migrateSystemPulseConfig();
  try {
    const migrated = migrateLegacyDatedChatLogs(getWorkspaceDir());
    if (migrated.files > 0) {
      console.log(`[chat-log] Migrated ${migrated.lines} exchange(s) from ${migrated.files} legacy daily log file(s) to chat-log/private/`);
    }
  } catch (_) {}
  try {
    const indexPath = getMemoryIndexPath();
    const renamed = migratePrivateChatLogFileNames(getWorkspaceDir(), {
      onRenamed(oldRel, newRel) {
        renameIndexedChatLogPath(indexPath, oldRel, newRel);
      },
    });
    if (renamed.renamed > 0) {
      console.log(`[chat-log] Renamed ${renamed.renamed} private chat log file(s) to human-readable names`);
    }
  } catch (_) {}
  if (authOnly && existsSync(getAuthDir())) {
    rmSync(getAuthDir(), { recursive: true });
    mkdirSync(getAuthDir(), { recursive: true });
  }

  if (authOnly) {
    beginCliSession();
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

  // Autonomy loops (mission engine + system pulse) are NOT started eagerly.
  // Per the architecture (see AGENTS.md and lib/agent/autonomy-gate.js): the
  // agent runs as a single-shot single-agent skills loop by default. Mission
  // engine ticking, curiosity-momentum, AI-suggested-tasks scanning, and the
  // system pulse only come online once the user has at least one durable
  // mission. We register the starter here; autonomy-gate fires it either
  // at boot (if missions already exist) or on the first createMission().
  configureAutonomy(() => {
    try {
      const cfg = loadConfig();
      const loopMs = Number(cfg?.missions?.loopMs) || 45 * 60_000;
      const curiosityIntervalMs = Number(cfg?.missions?.curiosityIntervalMs) || 150 * 60_000;
      startMissionEngine({
        loopMs,
        curiosityIntervalMs,
        runMissionTurn: async (mission, prompt) =>
          runInternalAgentTurn({
            targetAgentId: mission?.ownerAgentId || DEFAULT_AGENT_ID,
            userText: prompt,
            callerAgentId: DEFAULT_AGENT_ID,
            depth: 1,
            callChain: [DEFAULT_AGENT_ID, mission?.ownerAgentId || DEFAULT_AGENT_ID],
            persistHistory: true,
            missionId: mission?.id || '',
          }),
        onLog: (event) => {
          const baseDetails = event?.details && typeof event.details === 'object' ? event.details : {};
          logTeamActivity({
            type: event.type || 'mission_tick',
            agentId: event.ownerAgentId || event.agentId || DEFAULT_AGENT_ID,
            status: event.status || 'ok',
            message: event.message || event.title || 'Mission tick',
            title: event.title || baseDetails.title || '',
            details: {
              ...baseDetails,
              missionId: event.missionId || baseDetails.missionId || '',
              title: event.title || baseDetails.title || '',
            },
          });
        },
      });
      console.log('[missions] engine started');
    } catch (err) {
      console.log('[missions] engine failed to start:', getErrorMessageForLog(err));
    }
    try {
      startSystemPulse();
    } catch (err) {
      console.log('[system-pulse] failed to start:', getErrorMessageForLog(err));
    }
  });
  maybeStartOnBoot();

  let sock;
  const channelsConfig = getChannelsConfig();
  const envTelegramOnly = process.env.PASTURE_TELEGRAM_ONLY === '1' || process.env.PASTURE_TELEGRAM_ONLY === 'true';
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
  const MAX_CHAT_HISTORY_EXCHANGES = resolveChatHistoryExchanges(config.chatHistoryExchanges);

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
  function isTideGeneratedUserText(text) {
    const value = String(text || '').trim();
    return value === 'Tide check' || value === 'Tide nudge';
  }
  function lastUserMessageWasTideGenerated(historyMessages) {
    if (!Array.isArray(historyMessages)) return false;
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const msg = historyMessages[i];
      if (msg?.role !== 'user') continue;
      return isTideGeneratedUserText(msg.content);
    }
    return false;
  }
  async function runTideForJid(tideJid) {
    const trace = startRequestTrace({ source: 'tide_followup', jid: String(tideJid), agentId: 'main' });
    logRequestStart(trace);
    let tideStatus = 'ok';
    try {
      await _runTideForJid(tideJid, trace);
    } catch (err) {
      tideStatus = 'error';
    } finally {
      logRequestEnd(trace, tideStatus);
    }
  }

  async function _runTideForJid(tideJid) {
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
      ? readLastGroupExchanges(getWorkspaceDir(), tideJid, MAX_CHAT_HISTORY_EXCHANGES, tideSessionId)
      : readLastPrivateExchanges(getWorkspaceDir(), tideLogJid, MAX_CHAT_HISTORY_EXCHANGES, tideSessionId);
    // Only send one proactive Tide message per round. Tide-generated log entries are
    // synthetic "user" messages, so the next real user message must appear after them.
    const latestPrivateExchange = isTgGroup ? null : getLastPrivateExchange(getWorkspaceDir(), tideLogJid);
    const alreadySentTide = isTgGroup
      ? lastUserMessageWasTideGenerated(historyMessages)
      : isTideGeneratedUserText(latestPrivateExchange?.user);
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
            env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR },
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
        let text = isTelegramChatId(tideJid) ? rawText.replace(/^\[Pasture\]\s*/i, '').trim() : rawText;
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
      Math.max(1, Number(tide.healthCheckMinutes) || 7),
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
      if (isDailyLimitReached()) {
        const hoursLeft = Math.ceil(msUntilLimitResets() / 3_600_000);
        console.log(`[tide] Daily LLM limit reached — skipping follow-ups. Resets in ~${hoursLeft}h.`);
      } else {
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

  // ── Tide history nudge (completely separate from the silence follow-up) ────
  /** Per-JID timestamp of the last nudge sent. */
  const nudgeLastSentByJid = new Map();
  /** JIDs currently running a nudge — prevents overlapping runs for the same JID. */
  const nudgeRunningJids = new Set();
  /** Handle for the nudge interval. */
  let nudgeGlobalInterval = null;

  async function runNudgeForJid(nudgeJid) {
    const trace = startRequestTrace({ source: 'tide_nudge', jid: String(nudgeJid), agentId: 'main' });
    logRequestStart(trace);
    let status = 'ok';
    try {
      await _runNudgeForJid(nudgeJid);
    } catch (err) {
      status = 'error';
      console.error('[tide-nudge]', getErrorMessageForLog(err));
    } finally {
      logRequestEnd(trace, status);
    }
  }

  async function _runNudgeForJid(nudgeJid) {
    const config = getTideConfig();
    const tide = config.tide || {};
    if (!tide.enabled) return;
    const nudgeCfg = tide.nudge || {};
    if (nudgeCfg.enabled === false) return;
    const inactiveStart = tide.inactiveStart && String(tide.inactiveStart).trim();
    const inactiveEnd = tide.inactiveEnd && String(tide.inactiveEnd).trim();
    if (inactiveStart && inactiveEnd && isInTideInactiveWindow(inactiveStart, inactiveEnd)) return;
    const isTgJid = isTelegramChatId(nudgeJid);
    const waSock = whatsappSockRef.current;
    if (isTgJid && !telegramBot) return;
    if (!isTgJid && !waSock?.sendMessage) return;

    const nudgeLogJid = isTelegramGroupJid(nudgeJid) ? nudgeJid : toLogJid(nudgeJid);
    if (!isTelegramGroupJid(nudgeJid)) {
      const lastExchange = getLastPrivateExchange(getWorkspaceDir(), nudgeLogJid);
      if (isTideGeneratedUserText(lastExchange?.user)) {
        console.log('[tide-nudge] Last activity was Tide-generated — skipping until user replies');
        return;
      }
    }
    const lookbackDays = Math.max(1, Number(nudgeCfg.lookbackDays) || 7);
    const maxItems = Math.min(40, Math.max(5, Number(nudgeCfg.maxHistoryItems) || 20));
    const historyItems = readPrivateExchangesInWindow(getWorkspaceDir(), nudgeLogJid, lookbackDays, maxItems);
    if (!historyItems.length) {
      console.log('[tide-nudge] No history window for', String(nudgeJid).slice(0, 20), '— skipping');
      return;
    }

    const nudgeBootstrap = buildSessionBootstrapContext(getWorkspaceDir(), {
      logJid: isTelegramGroupJid(nudgeJid) ? undefined : nudgeLogJid,
    }).block;

    const payload = JSON.stringify({
      jid: nudgeJid,
      storePath: getCronStorePath(),
      workspaceDir: getWorkspaceDir(),
      historyItems,
      bootstrapBlock: nudgeBootstrap,
    });

    let textToSend = '';
    let sendOk = false;
    try {
      textToSend = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['cron/run-tide-nudge.js'], {
          cwd: __dirname,
          stdio: ['pipe', 'pipe', 'inherit'],
          env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR },
        });
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('exit', (code, signal) => {
          if (code !== 0 && code != null) { reject(new Error(`run-tide-nudge exited ${code}`)); return; }
          if (signal) { reject(new Error(`run-tide-nudge killed: ${signal}`)); return; }
          const lastLine = out.trim().split('\n').filter(Boolean).pop() || '';
          try {
            const parsed = JSON.parse(lastLine);
            if (parsed.error) reject(new Error(parsed.error));
            else resolve(parsed.textToSend || '');
          } catch (e) {
            reject(new Error(lastLine.slice(0, 100) || e.message || 'run-tide-nudge invalid output'));
          }
        });
        child.on('error', reject);
        child.stdin.end(payload, 'utf8');
      });
      sendOk = true;
    } catch (e) {
      console.error('[tide-nudge] subprocess failed:', getErrorMessageForLog(e));
    }

    if (sendOk) {
      const rawText = sanitizeOutboundText((textToSend || '').trim());
      let text = isTelegramChatId(nudgeJid) ? rawText.replace(/^\[Pasture\]\s*/i, '').trim() : rawText;
      const nothingPhrases = /^(nothing|n\/?a|no(ne)?\s*to\s*do|all\s*good|nothing\s*to\s*report\.?)\s*\.?$/i;
      if (!text || (text.length < 20 && nothingPhrases.test(text))) {
        console.log('[tide-nudge] Empty/useless response — skipping send');
        return;
      }
      const nudgeJidShort = String(nudgeJid).slice(0, 20) + (String(nudgeJid).length > 20 ? '…' : '');
      try {
        if (isTgJid && telegramBot) {
          await sendLongText(telegramBot, Number(nudgeJid), text);
        } else if (waSock?.sendMessage) {
          await waSock.sendMessage(nudgeJid, { text });
        }
        nudgeLastSentByJid.set(nudgeJid, Date.now());
        console.log('[tide-nudge] Nudge sent to', nudgeJidShort);
      } catch (e) {
        console.error('[tide-nudge] Send failed:', getErrorMessageForLog(e));
      }
      const exchange = {
        user: 'Tide nudge',
        assistant: text,
        timestampMs: Date.now(),
        jid: nudgeLogJid,
        sessionId: null,
      };
      try {
        const memoryConfig = getMemoryConfig();
        if (memoryConfig && !isTelegramGroupJid(nudgeJid)) {
          await indexChatExchange(memoryConfig, exchange);
        } else {
          appendExchange(getWorkspaceDir(), exchange);
        }
      } catch (err) {
        console.error('[tide-nudge] Chat log write failed:', err.message);
      }
    }
  }

  function startTideNudge() {
    const config = getTideConfig();
    const tide = config.tide || {};
    if (!tide.enabled) return;
    const nudgeCfg = tide.nudge || {};
    if (nudgeCfg.enabled === false) {
      console.log('[tide-nudge] Disabled via tide.nudge.enabled = false.');
      return;
    }
    const intervalMinutes = Math.max(30, Number(nudgeCfg.intervalMinutes) || 120);
    if (nudgeGlobalInterval) clearInterval(nudgeGlobalInterval);
    // Poll more frequently than the interval so we don't overshoot by a full poll cycle.
    const pollMinutes = Math.min(intervalMinutes, 30);
    console.log('[tide-nudge] Enabled — history nudge every', intervalMinutes, 'min (poll every', pollMinutes, 'min).');
    nudgeGlobalInterval = setInterval(() => {
      if (isDailyLimitReached()) return;
      const now = Date.now();
      const intervalMs = intervalMinutes * 60 * 1000;
      // tideTimerByJid tracks which JIDs are actively monitored by Tide.
      for (const [jid] of tideTimerByJid) {
        if (nudgeRunningJids.has(jid)) continue;
        const lastSent = nudgeLastSentByJid.get(jid) || 0;
        if (now - lastSent < intervalMs) continue;
        const jidShort = String(jid).slice(0, 20) + (String(jid).length > 20 ? '…' : '');
        console.log('[tide-nudge] Nudge due for', jidShort);
        nudgeRunningJids.add(jid);
        runNudgeForJid(jid)
          .catch((e) => console.error('[tide-nudge]', getErrorMessageForLog(e)))
          .finally(() => nudgeRunningJids.delete(jid));
      }
    }, pollMinutes * 60 * 1000);
  }

  function stopTideNudge() {
    if (nudgeGlobalInterval) {
      clearInterval(nudgeGlobalInterval);
      nudgeGlobalInterval = null;
    }
    nudgeRunningJids.clear();
    console.log('[tide-nudge] Stopped.');
  }
  // ── end Tide history nudge ─────────────────────────────────────────────────

  const WHO_AM_I_MD = 'WhoAmI.md';
  const MY_HUMAN_MD = 'MyHuman.md';
  const SOUL_MD = 'SOUL.md';
  const GROUP_MD = 'group.md';

  const WORKSPACE_DEFAULT_FILES = [WHO_AM_I_MD, MY_HUMAN_MD, SOUL_MD, GROUP_MD];
  const INSTALL_DIR = (process.env.PASTURE_INSTALL_DIR && resolve(process.env.PASTURE_INSTALL_DIR)) || __dirname;
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
      if (agentId === DEFAULT_AGENT_ID) syncMainAgentIdentityFromWorkspace();
      return buildOneOnOneSystemPrompt(getAgentWorkspaceDir(agentId), { agentId }) + buildAgentTeamPromptBlock(agentId);
    }
    if (agentId === DEFAULT_AGENT_ID) syncMainAgentIdentityFromWorkspace();
    const basePrompt = buildOneOnOneSystemPrompt(getAgentWorkspaceDir(agentId), { agentId });
    const loaded = loadGroupMd(getWorkspaceDir(), DEFAULT_WORKSPACE_DIR);
    const groupBlock = buildGroupPromptBlock(loaded, {
      groupSenderName: opts.groupSenderName,
      groupMentioned: !!opts.groupMentioned,
      groupNonOwner: !!opts.groupNonOwner,
    });
    console.log('[path] buildSystemPrompt groupBlockLen=', (groupBlock || '').length, 'basePromptLen=', basePrompt.length);
    return groupBlock ? (basePrompt + '\n\n' + groupBlock) : basePrompt;
  }

  /** Normalize text for the user (no [Pasture], no "agent replied:" wrappers). */
  function sanitizeOutboundText(text) {
    if (text == null) return '';
    const normalized = String(text)
      .replace(/\s*—\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return formatUserFacingReply(normalized);
  }

  async function runAgentWithSkills(sock, jid, text, lastSentByJidMap, selfJidForCron, ourSentIdsRef, bioOpts = {}) {
    const isGroupJidForTrace = isTelegramGroupJid(jid) || isWhatsAppGroupJid(jid);
    const trace = startRequestTrace({
      jid: isGroupJidForTrace ? jid : toLogJid(jid),
      channel: bioOpts.timingChannel || 'chat',
      receivedAtMs: bioOpts.receivedAtMs,
      userPreview: text,
      agentId: (bioOpts.agentIdOverride && String(bioOpts.agentIdOverride).trim()) || DEFAULT_AGENT_ID,
      source: bioOpts.timingSource || 'user_message',
    });
    return runWithRequestTrace(trace, async () => {
      logRequestStart(trace);
      try {
        return await runAgentWithSkillsBody(sock, jid, text, lastSentByJidMap, selfJidForCron, ourSentIdsRef, bioOpts, trace);
      } catch (err) {
        logRequestEnd(trace, 'error', { error: getErrorMessageForLog(err) });
        throw err;
      }
    });
  }

  async function runAgentWithSkillsBody(sock, jid, text, lastSentByJidMap, selfJidForCron, ourSentIdsRef, bioOpts = {}, trace = null) {
    let skillsCalled = [];
    console.log('[agent] handling:', text.slice(0, 50) + (text.length > 50 ? '…' : ''));
    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch (_) {}
    const isGroupJid = isTelegramGroupJid(jid) || isWhatsAppGroupJid(jid);
    const logJid = isGroupJid ? jid : toLogJid(jid);
    const sessionLogKey = String(logJid || jid).trim();
    const { sessionId, rotated: sessionRotated, reason: sessionReason } = ensureChatSession(sessionLogKey, { userText: text });
    if (sessionRotated) clearInMemoryHistoryForJids(jid, logJid, sessionLogKey);
    if (shouldAckNewSessionOnly(sessionReason, text)) {
      const replyText = NEW_SESSION_ACK;
      try {
        const sent = await sock.sendMessage(jid, { text: replyText });
        if (sent?.key?.id && ourSentIdsRef?.current) {
          ourSentIdsRef.current.add(sent.key.id);
          if (ourSentIdsRef.current.size > MAX_OUR_SENT_IDS) {
            const first = ourSentIdsRef.current.values().next().value;
            if (first) ourSentIdsRef.current.delete(first);
          }
        }
        lastSentByJidMap.set(jid, replyText);
        pushExchange(jid, text, replyText, sessionId);
        const exchange = { user: text, assistant: replyText, timestampMs: Date.now(), jid: logJid, sessionId };
        if (bioOpts.logExchange) {
          bioOpts.logExchange(exchange);
        } else if (!isGroupJid) {
          const memoryConfig = getMemoryConfig();
          if (memoryConfig) {
            indexChatExchange(memoryConfig, exchange)
              .then((logMeta) => afterExchangeLogged(getWorkspaceDir(), exchange, logMeta))
              .catch((err) => console.error('[memory] auto-index failed:', err.message));
          } else {
            const logMeta = appendExchange(getWorkspaceDir(), exchange);
            afterExchangeLogged(getWorkspaceDir(), exchange, logMeta);
          }
        }
        console.log('[replied] (new session ack)');
      } catch (sendErr) {
        lastSentByJidMap.set(jid, replyText);
        if (!isTelegramChatId(jid)) pendingReplies.push({ jid, text: replyText });
        else addPendingTelegram(jid, replyText);
        console.log('[replied] new session ack queued (send failed):', getErrorMessageForLog(sendErr));
      }
      if (trace) logRequestEnd(trace, 'ok', { skillsCalled: [], note: 'new_session_ack' });
      return { skillsCalled: [] };
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
    const inMemoryHistory = getLast5ExchangesForSession(jid, sessionId);
    const historyMessages = isGroupJid
      ? readLastGroupExchanges(getWorkspaceDir(), jid, MAX_CHAT_HISTORY_EXCHANGES, sessionId)
      : (inMemoryHistory.length > 0
          ? inMemoryHistory
          : readLastPrivateExchanges(getWorkspaceDir(), logJid, MAX_CHAT_HISTORY_EXCHANGES, sessionId));
    const activeAgentTeamId = getAgentTeamId(agentId);
    let focusedProject = resolveFocusedProjectForTurn({ userText: text, historyMessages });
    if (!focusedProject && activeAgentTeamId) {
      const teamProjects = listProjectsForTeam(activeAgentTeamId);
      if (teamProjects.length === 1) focusedProject = teamProjects[0];
    }
    const focusedProjectTeamId = getProjectTeamId(focusedProject);
    const taskFrameRouting = !isGroupJid
      ? await traceAsyncStep('task_frame', () => classifyTaskFrameTurn({
          logKey: sessionLogKey,
          userText: text,
          historyMessages,
          availableSkillIds: enabledSkillIds,
          availableSkillSummaries: enabledSkillSummaries,
          agentId,
        }))
      : null;
    const taskFrameDecision = taskFrameRouting?.decision || null;
    let activeTaskFrame = taskFrameRouting?.activeFrame || null;
    let taskFrameFastPath = false;
    let taskFrameRoute = null;
    if (taskFrameDecision) {
      console.log('[task-frame]', JSON.stringify({
        action: taskFrameDecision.action,
        confidence: taskFrameDecision.confidence,
        kind: taskFrameDecision.kind,
        title: taskFrameDecision.title || '',
        activeFrameId: activeTaskFrame?.id || '',
        tools: taskFrameDecision.toolProfile || [],
      }));
      logTeamActivity({
        type: 'task_frame_decision',
        agentId,
        status: taskFrameDecision.action,
        jid,
        message: taskFrameDecision.reason || taskFrameDecision.plan || '',
        details: {
          confidence: taskFrameDecision.confidence,
          kind: taskFrameDecision.kind,
          title: taskFrameDecision.title,
          activeFrameId: activeTaskFrame?.id || '',
          toolProfile: taskFrameDecision.toolProfile || [],
        },
      });
    }
    if (taskFrameDecision?.action === 'exit' && taskFrameDecision.confidence >= 0.72) {
      const closed = clearTaskFrame(sessionLogKey, { reason: taskFrameDecision.reason || 'user_exit' });
      activeTaskFrame = null;
      console.log('[task-frame] closed', JSON.stringify({ frameId: closed?.id || '', reason: taskFrameDecision.reason || '' }));
      logTeamActivity({
        type: 'task_frame_closed',
        agentId,
        status: 'closed',
        jid,
        message: taskFrameDecision.reason || 'Task frame closed.',
        details: { frameId: closed?.id || '' },
      });
    } else if (taskFrameDecision?.action === 'new' && taskFrameDecision.confidence >= 0.72) {
      activeTaskFrame = upsertTaskFrame(sessionLogKey, taskFrameDecision, activeTaskFrame, { userText: text });
      console.log('[task-frame] created', JSON.stringify({
        frameId: activeTaskFrame?.id || '',
        kind: activeTaskFrame?.kind || '',
        skills: activeTaskFrame?.toolProfile || [],
      }));
      logTeamActivity({
        type: 'task_frame_created',
        agentId,
        status: 'active',
        jid,
        message: activeTaskFrame?.objective || activeTaskFrame?.title || 'Task frame created.',
        details: {
          frameId: activeTaskFrame?.id || '',
          kind: activeTaskFrame?.kind || '',
          toolProfile: activeTaskFrame?.toolProfile || [],
        },
      });
    } else if (shouldUseTaskFrameFastPath(taskFrameDecision)) {
      activeTaskFrame = upsertTaskFrame(sessionLogKey, taskFrameDecision, activeTaskFrame, { userText: text });
      taskFrameRoute = taskFrameDecisionToTurnRoute(taskFrameDecision, activeTaskFrame);
      taskFrameFastPath = !!taskFrameRoute;
      console.log('[task-frame] fast-path', JSON.stringify({
        frameId: activeTaskFrame?.id || '',
        kind: activeTaskFrame?.kind || '',
        skills: taskFrameRoute?.skills || [],
      }));
      logTeamActivity({
        type: 'task_frame_fast_path',
        agentId,
        status: taskFrameDecision.action,
        jid,
        message: activeTaskFrame?.objective || activeTaskFrame?.title || 'Using active task frame.',
        details: {
          frameId: activeTaskFrame?.id || '',
          kind: activeTaskFrame?.kind || '',
          toolProfile: taskFrameRoute?.skills || [],
        },
      });
    }
    // Step 1.5: classify work-mode for this turn (LLM, MD-driven).
    //
    // Two-tier gating:
    //   - The classifier always runs (so any turn can be the one that
    //     toggles the mode), and the persisted mode is updated immediately.
    //   - But the operational mode that gates THIS turn's pipeline is the
    //     mode the session was in BEFORE the classifier ran. That is, when
    //     the user says "enable work mode", this turn still runs as a
    //     single-agent skills loop and just acks the switch. The next turn
    //     onwards picks up the multi-agent pipeline (delegation, intent
    //     planner, work-durability pre-fill, missions/projects/workflow
    //     context blocks). This matches the design described by the user
    //     and avoids running heavy multi-agent context for a turn whose
    //     only real content is the toggle acknowledgement.
    //
    // Group chats are always single-mode (group flows skip multi-agent today).
    let workModeAck = null;
    let workMode = isGroupJid ? 'single' : getSessionWorkMode(sessionLogKey);
    if (taskFrameFastPath) {
      console.log('[work-mode]', JSON.stringify({ mode: workMode, skipped: 'task_frame_fast_path' }));
    } else if (!isGroupJid) {
      const wm = await traceAsyncStep('work_mode', () => resolveWorkModeForTurn({
        userText: text,
        logKey: sessionLogKey,
        agentId,
      }));
      if (wm) {
        workMode = wm.modeBefore;
        if (wm.toggled) {
          workModeAck = wm.ack;
          console.log('[work-mode]', JSON.stringify({
            before: wm.modeBefore,
            after: wm.modeAfter,
            effectiveThisTurn: wm.modeBefore,
            reason: wm.reason,
          }));
        } else {
          console.log('[work-mode]', JSON.stringify({ mode: workMode }));
        }
      }
    }
    const isMultiAgent = !taskFrameFastPath && !isGroupJid && workMode === 'multi' && !!focusedProjectTeamId && focusedProjectTeamId === activeAgentTeamId;
    const teamGateReply = !taskFrameFastPath && !isGroupJid && workMode === 'multi' && !workModeAck && !isNonTaskMessage(text) && !isMultiAgent
      ? buildProjectTeamGateReply({
          agentId,
          agentTeamId: activeAgentTeamId,
          focusedProject,
          focusedProjectTeamId,
        })
      : '';
    if (!taskFrameFastPath && !isGroupJid && workMode === 'multi' && !isMultiAgent) {
      console.log('[team-gate]', JSON.stringify({
        mode: teamGateReply ? 'blocked' : 'single',
        reason: focusedProjectTeamId ? 'agent_not_on_project_team' : 'no_project_team',
        projectId: focusedProject?.id || '',
        projectTeamId: focusedProjectTeamId || '',
        agentTeamId: activeAgentTeamId || '',
      }));
    }
    // Step 2: decide work durability before delegation. Persistence must be
    // attached to the turn before agent-send chooses who should do the work.
    // Single-agent mode skips this entirely — focus is on tool execution.
    const durabilityDecision = isMultiAgent
      ? await traceAsyncStep('work_durability', () => prepareWorkDurabilityWithAi({ userText: text, historyMessages, agentId }))
      : null;
    if (durabilityDecision?.missionId) ctx.missionId = durabilityDecision.missionId;
    if (durabilityDecision) {
      console.log('[work-durability]', JSON.stringify({
        kind: durabilityDecision.kind,
        persistence: durabilityDecision.persistence,
        missionId: durabilityDecision.missionId || '',
        createdMission: !!durabilityDecision.createdMission,
      }));
    }
    // Step 3: specialization-aware delegation check before planner.
    // This runs after durability so agent-send can receive a missionId up front.
    // Skipped in single-agent mode.
    const durableDelegationContext = isMultiAgent
      ? buildDurableDelegationContext(durabilityDecision, {
          agentId,
          availableSkillIds: enabledSkillIds,
        })
      : null;
    const delegationContext = durableDelegationContext || (isMultiAgent
      ? await traceAsyncStep('delegation_context', () => buildDelegationContext({
          agentId,
          userText: delegationRoutingTextFromDurability(durabilityDecision, text),
          availableSkillIds: enabledSkillIds,
        }))
      : null);
    const delegatedTarget = delegationContext?.recommendation?.action === 'delegate'
      ? (delegationContext?.recommendation?.targetAgentId || '')
      : '';
    const delegationBlocked = !!delegationContext?.recommendation?.blocked;
    const delegationDecision = buildDelegationDecisionDetails(delegationContext);
    // Don't force agent-send when the explicit target isn't linked from this
    // caller (recommendation.blocked === true) — that just wastes an LLM call
    // and surfaces a policy error. Let the coordinator answer instead.
    const presetDelegationPlan = delegatedTarget
      && delegationContext?.recommendation?.action === 'delegate'
      && !delegationBlocked
      ? {
          mode: 'tool',
          skills: [
            ...(durabilityDecision?.persistence && durabilityDecision.persistence !== 'none' && enabledSkillIds.includes('project-workflow') ? ['project-workflow'] : []),
            'agent-send',
          ],
          executionMode: durabilityDecision?.persistence && durabilityDecision.persistence !== 'none'
            ? 'persistent_delegation'
            : 'delegation',
          usesExistingWorkIntake: !!(durabilityDecision?.persistence && durabilityDecision.persistence !== 'none'),
          plan: `Delegate to ${delegatedTarget} via agent-send first; that agent is the best specialization match for this request.`,
          answer_style: 'short',
        }
      : null;
    if (!isGroupJid) {
      ctx.delegationHistoryMessages = historyMessages;
      ctx.channelContext = {
        logJid,
        workspaceDir: workspaceDirForBootstrap,
        sessionBootstrap: sessionBootstrap || '',
      };
    }
    if (presetDelegationPlan && delegationDecision) {
      logTeamActivity({
        type: 'delegation_decision',
        agentId,
        targetAgentId: delegatedTarget,
        status: 'ok',
        depth: 0,
        jid,
        message: delegationContext?.recommendation?.routingMethod === 'llm'
          ? `Delegation decision (LLM router) selected ${delegatedTarget}`
          : `Delegation decision selected ${delegatedTarget}`,
        details: delegationDecision,
      });
    } else if (delegationBlocked && delegatedTarget && delegationDecision) {
      logTeamActivity({
        type: 'delegation_decision',
        agentId,
        targetAgentId: delegatedTarget,
        status: 'blocked',
        depth: 0,
        jid,
        message: `User mentioned ${delegatedTarget}, but ${delegatedTarget} is not linked from ${agentId}; coordinator will answer instead.`,
        details: delegationDecision,
      });
    } else if (delegationDecision && delegationContext?.teamCapability) {
      logTeamActivity({
        type: 'team_capability_evaluation',
        agentId,
        status: 'ok',
        depth: 0,
        jid,
        message: `Team capability: ${delegationDecision.action || 'handle-in-main'}`,
        details: delegationDecision,
      });
    }
    // Step 4: turn router — one small LLM call before loading any tool schemas.
    //
    // The planner (and its companion hint classifiers — casual chat, missions
    // discovery, github source) is a multi-agent / work-mode concern. In
    // single-agent mode the agent simply runs the skills tool loop directly
    // with the full enabled skill list; there is no pre-routing decision to
    // make, no delegation to plan around, no durable work to preserve. Skipping
    // the planner in single mode saves one LLM call per turn and keeps the
    // default conversational path lean.
    const turnIntent = isMultiAgent && !presetDelegationPlan
      ? await traceAsyncStep('turn_intent', () => classifyTurnIntent({
          userText: text,
          historyMessages,
          availableSkillIds: enabledSkillIds,
          availableSkillSummaries: enabledSkillSummaries,
          currentWorkMode: workMode,
          agentId,
        }))
      : null;
    if (turnIntent) console.log('[turn-intent]', JSON.stringify(turnIntent));
    const turnIntentIsConfident = turnIntent && turnIntent.confidence >= 0.65;
    const casualIntentPlan = isMultiAgent && !presetDelegationPlan
      ? (turnIntentIsConfident
          ? buildCasualPlanFromTurnIntent(turnIntent)
          : (isNonTaskMessage(text) ? buildCasualChatTurnRoute() : null))
      : null;
    const missionForIntent = isMultiAgent && !presetDelegationPlan && !casualIntentPlan && turnIntentIsConfident && turnIntent.project_or_mission_intent !== 'none'
      ? resolveMissionForUserTurn({
          userText: text,
          historyMessages,
          agentId,
          projectOrMissionIntent: turnIntent.project_or_mission_intent,
        })
      : null;
    const missionsIntentHint = missionForIntent
      ? buildMissionIntentPlan(missionForIntent, enabledSkillIds)
      : null;
    const githubIntentHint = isMultiAgent && !presetDelegationPlan && !casualIntentPlan
      ? (turnIntentIsConfident && turnIntent.github_source_intent
          ? buildGithubSourceIntentPlan(enabledSkillIds)
          : null)
      : null;
    const selfInspection = isMultiAgent && !presetDelegationPlan && enabledSkillIds.length > 0
      ? await traceAsyncStep('self_inspection', () => classifySelfInspection({
          userText: text,
          historyMessages,
          agentId,
        }))
      : null;
    const selfInspectionPlan = buildSelfInspectionIntentPlan(selfInspection, enabledSkillIds);
    if (selfInspection) console.log('[self-inspection]', JSON.stringify(selfInspection));
    if (selfInspectionPlan) console.log('[self-inspection-plan]', JSON.stringify({
      skills: selfInspectionPlan.skills,
      target: selfInspection?.target || '',
    }));
    const turnRoute = taskFrameRoute || presetDelegationPlan || selfInspectionPlan || casualIntentPlan || missionsIntentHint || githubIntentHint || (isMultiAgent && enabledSkillIds.length > 0
      ? await traceAsyncStep('turn_router', () => routeTurn({
          userText: text,
          historyMessages,
          availableSkillIds: enabledSkillIds,
          availableSkillSummaries: enabledSkillSummaries,
          agentId,
          delegationContext,
          workDurability: durabilityDecision,
        }))
      : null);
    if (turnRoute) console.log('[turn-router]', JSON.stringify(turnRoute));
    // Step 5: load tool schemas. In single-agent mode there is no semantic
    // pre-router: load the full enabled skill set and let skill docs/schemas
    // determine which tool the model calls. In multi-agent mode, route hints can
    // still narrow tools for delegation / durable work.
    //   turnRoute === null      → full tools (single mode or router fallback)
    //   turnRoute.skills = []   → router: chat   → skip schema loading entirely
    //   turnRoute.skills = [...] → router: tools  → load only selected schemas
    const plannerSaysNoTools = turnRoute !== null && Array.isArray(turnRoute.skills) && turnRoute.skills.length === 0;
    let skillContext = null;
    let toolsForRequest = [];
    if (!plannerSaysNoTools) {
      skillContext = getSkillContext({ groupJid: groupJidForSkills, agentId, hintSkills: turnRoute?.skills ?? null });
      toolsForRequest = Array.isArray(skillContext.runSkillTool) && skillContext.runSkillTool.length > 0
        ? skillContext.runSkillTool
        : [];
    }
    const toolNames = toolsForRequest.map((t) => t?.function?.name).filter(Boolean);
    console.log(
      '[path] plannerMode=', turnRoute?.mode ?? 'fallback',
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
    const systemPrompt = buildSystemPrompt(systemPromptOpts);
    const planBlock = turnRouteToSystemBlock(turnRoute);
    let systemPromptWithPlan = planBlock ? systemPrompt + '\n\n' + planBlock : systemPrompt;
    if (taskFrameFastPath && activeTaskFrame) {
      systemPromptWithPlan += taskFrameToSystemBlock(activeTaskFrame, taskFrameDecision);
    }
    if (sessionBootstrap) systemPromptWithPlan += sessionBootstrap;
    if (!isGroupJid) {
      // durability block is null-safe when durabilityDecision is null
      systemPromptWithPlan += buildDurabilitySystemBlock(durabilityDecision);
      const memoryConfig = getMemoryConfig();
      const retroBlock = await buildRetrospectiveContextBlock(text, memoryConfig);
      if (retroBlock) systemPromptWithPlan += retroBlock;
      // Multi-agent mode adds mission / project / workflow context. Single-agent
      // mode keeps the system prompt focused on direct tool execution.
      if (isMultiAgent && !isNonTaskMessage(text)) {
        const missionsBlock = buildMissionsContextBlock({
          userText: text,
          historyMessages,
          agentId,
          projectOrMissionIntent: turnIntentIsConfident ? turnIntent.project_or_mission_intent : 'none',
        });
        if (missionsBlock) systemPromptWithPlan += missionsBlock;
        const projectsBlock = buildProjectsContextBlock({ userText: text, historyMessages });
        if (projectsBlock) systemPromptWithPlan += projectsBlock;
        const workflowBlock = buildProjectWorkflowContextBlock({ userText: text, historyMessages, agentId });
        if (workflowBlock) systemPromptWithPlan += workflowBlock;
      }
    }
    const llmOptions = agentId ? { agentId } : {};
    console.log('[path] runAgentTurn systemPromptLen=', systemPromptWithPlan.length, 'toolsCount=', toolsForRequest.length);
    ctx._originalUserText = text;
    let turnResult = teamGateReply
      ? { textToSend: teamGateReply, skillsCalled: [] }
      : null;
    if (!turnResult && presetDelegationPlan && delegatedTarget) {
      try {
        logTeamActivity({
          type: 'turn_start',
          agentId,
          depth: 0,
          jid,
          message: text,
        });
        onAgentTurnStart({ agentId, userText: text, ctx });
        console.log('[agent-router] forcing agent-send to', delegatedTarget);
        if (delegationDecision) ctx.delegationRouting = delegationDecision;
        const forcedRaw = await traceAsyncStep('forced_delegation', () => executeSkill('agent-send', ctx, {
          agent: delegatedTarget,
          message: enrichMessageWithProjectContext(text, historyMessages),
          ...delegationArgsFromDurability(durabilityDecision, text),
        }), { targetAgentId: delegatedTarget });
        const forced = JSON.parse(forcedRaw || '{}');
        if (forced && typeof forced.reply === 'string' && forced.reply.trim()) {
          turnResult = {
            textToSend: forced.reply.trim(),
            skillsCalled: ['agent-send'],
          };
        } else if (forced && typeof forced.error === 'string') {
          console.log('[agent-router] forced agent-send failed:', forced.error);
          turnResult = {
            textToSend: `[Pasture] ${forced.error.trim()}`,
            skillsCalled: ['agent-send'],
          };
        }
        if (turnResult) {
          const forcedSkills = Array.isArray(turnResult.skillsCalled) ? turnResult.skillsCalled : [];
          logTeamActivity({
            type: 'turn_done',
            agentId,
            depth: 0,
            jid,
            status: 'ok',
            message: `Handled in forced route using ${forcedSkills.length} skill${forcedSkills.length === 1 ? '' : 's'}.`,
          });
          onAgentTurnDone({ agentId });
        }
      } catch (err) {
        console.log('[agent-router] forced agent-send exception:', getErrorMessageForLog(err));
      }
    }
    if (!turnResult) {
      turnResult = await traceAsyncStep('agent_turn', () => runAgentTurn({
        userText: text,
        ctx,
        systemPrompt: systemPromptWithPlan,
        tools: toolsForRequest,
        historyMessages,
        getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
        resolveToolName: skillContext?.resolveToolName ?? (() => null),
      }), { agentId, toolsCount: toolsForRequest.length });
    }
    if (
      selfInspectionPlan
      && Array.isArray(toolsForRequest)
      && toolsForRequest.length > 0
      && (!Array.isArray(turnResult?.skillsCalled) || turnResult.skillsCalled.length === 0)
    ) {
      console.log('[self-inspection] retrying because the first agent turn used no tools');
      const retryPrompt = systemPromptWithPlan +
        '\n\n--- Self-Inspection Tool Requirement ---\n' +
        'This turn was classified as Pasture/CowCode self-inspection. Before final answering, call at least one available local inspection tool and ground the answer in what it returns.\n' +
        '---';
      turnResult = await traceAsyncStep('self_inspection_retry', () => runAgentTurn({
        userText: text,
        ctx,
        systemPrompt: retryPrompt,
        tools: toolsForRequest,
        historyMessages,
        getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
        resolveToolName: skillContext?.resolveToolName ?? (() => null),
      }), { agentId, toolsCount: toolsForRequest.length });
    }
    const { textToSend, voiceReplyText, imageReplyPath, imageReplyCaption, skillsCalled: called } = turnResult || {};
    let skillsCalledFromTurn = Array.isArray(called) && called.length ? called : [];
    if (Array.isArray(called) && called.length) skillsCalled = called;
    let rawTextToSend = (textToSend || '').trim();
    if (taskFrameFastPath && activeTaskFrame) {
      const updatedFrame = updateTaskFrameAfterTurn(sessionLogKey, {
        userText: text,
        assistantText: rawTextToSend,
        skillsCalled: skillsCalledFromTurn,
      });
      console.log('[task-frame] updated', JSON.stringify({
        frameId: updatedFrame?.id || activeTaskFrame.id || '',
        status: updatedFrame?.status || activeTaskFrame.status || '',
        skillsCalled: skillsCalledFromTurn,
      }));
      logTeamActivity({
        type: 'task_frame_update',
        agentId,
        status: updatedFrame?.status || activeTaskFrame.status || 'active',
        jid,
        message: updatedFrame?.objective || activeTaskFrame.objective || activeTaskFrame.title || 'Task frame updated.',
        details: {
          frameId: updatedFrame?.id || activeTaskFrame.id || '',
          skillsCalled: skillsCalledFromTurn,
        },
      });
    }
    const healthNote = !isGroupJid ? getPendingHealthFlags() : '';
    if (healthNote && rawTextToSend) rawTextToSend = healthNote + '\n\n' + rawTextToSend;
    // If the user toggled work mode this turn, surface the acknowledgement
    // up front so they see the mode change before the rest of the reply.
    if (workModeAck) {
      rawTextToSend = rawTextToSend
        ? '[Pasture] ' + workModeAck + '\n\n' + rawTextToSend.replace(/^\[Pasture\]\s*/i, '')
        : '[Pasture] ' + workModeAck;
    }
    const cleanedTextToSend = sanitizeOutboundText(rawTextToSend);
    logOutboundReplyDecorations(rawTextToSend, cleanedTextToSend, { channel: jid });
    const cleanedVoiceReplyText = sanitizeOutboundText(voiceReplyText || '');
    const textForSend = cleanedTextToSend;
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
      const captionForImage = (replyText && replyText.trim()) ? replyText.trim() : (imageReplyCaption || '');
      await traceAsyncStep('outbound_send', async () => {
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
      });
    }
    if (trace) logRequestEnd(trace, 'ok', { skillsCalled: skillsCalled || [] });
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
        lastSent.set(testJid, (err && err.message ? err.message : String(err)));
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
      startTideNudge();
      startRetrospective();
      // Autonomy loops (mission engine + system pulse) are NOT started here.
      // They are gated by lib/agent/autonomy-gate.js and come online only
      // once a mission exists. See configureAutonomy() in main().
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
      startTideNudge();
      startRetrospective();
      // System pulse is gated by autonomy-gate.js (missions presence).
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
        startTideNudge();
        startRetrospective();
        // System pulse is gated by autonomy-gate.js (missions presence).
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
      stopTideNudge();
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

      // Do not treat our own Pasture replies as user input.
      if (userText.startsWith('[Pasture]')) continue;

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
          const errorText = '[Pasture] ' + toUserMessage(err);
          sock.sendMessage(jid, { text: errorText }).catch(() => {
            pendingReplies.push({ jid, text: errorText });
          });
        });
      } catch (err) {
        console.error('LLM error:', err.message);
        const errorText = '[Pasture] ' + toUserMessage(err);
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
