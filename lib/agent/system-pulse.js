/**
 * System Pulse — periodic self-improvement loop.
 *
 * Two independent checks on timers:
 *   1. Health check (every ~45 min): parse logs, check LLM, cron, transport, disk. No LLM cost.
 *   2. Output pattern check (every ~8 hours): sample recent chats, LLM finds behavioral patterns,
 *      proposes self-edits to SOUL.md / skill descriptions with a safety gate.
 *
 * Not a skill, not a mission, not a task. Daemon-level maintenance, like retrospective.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync, readdirSync, appendFileSync, symlinkSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getStateDir, getWorkspaceDir, getConfigPath, getCronStorePath, getSelfEditsLogPath } from '../util/paths.js';
import {
  getCurrentDaemonErrPath,
  getCurrentDaemonLogPath,
  getDailyDaemonErrPath,
  getDailyDaemonLogPath,
} from '../util/daemon-log-path.js';
import { chat as llmChat, isDailyLimitReached } from '../../llm.js';
import { runMdPrompt } from './md-llm.js';
import { readChatLogsForLocalDates } from '../context/chat-log.js';
import { getResolvedTimezone } from '../util/timezone.js';
import { startRequestTrace, runWithRequestTrace, logRequestStart, logRequestEnd, traceAsyncStep } from '../util/request-timing.js';
import { basenameAnyPath } from '../util/cross-platform-path.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
  enabled: true,
  healthIntervalMinutes: 45,
  patternIntervalHours: 8,
  maxPatternsPerRun: 2,
  selfEditConfidenceThreshold: 0.7,
  healthNotify: true,
  dryRun: false,
};

const MAX_EDITS_PER_FILE_48H = 3;

let healthTimer = null;
let patternTimer = null;
let pendingHealthFlags = [];

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(path, obj) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

function getPulseStatePath() {
  return join(getStateDir(), 'system-pulse.json');
}

function getBackupsDir() {
  const dir = join(getStateDir(), 'backups');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getHealthPath() {
  return join(getStateDir(), 'health.json');
}

function refreshCurrentSelfEditsLink(dir, targetName) {
  try {
    const linkPath = join(dir, 'current.log');
    try {
      unlinkSync(linkPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    symlinkSync(targetName, linkPath);
  } catch (_) {
    // The dated log remains the source of truth.
  }
}

/** Migration: ensure systemPulse block exists in config.json. Called on daemon startup. */
export function migrateSystemPulseConfig() {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return;
    const config = readJson(path, {});
    if (config.systemPulse != null && typeof config.systemPulse === 'object') return;
    config.systemPulse = { ...DEFAULT_CONFIG };
    writeJson(path, config);
  } catch (_) {}
}

export function loadPulseConfig() {
  try {
    const raw = readJson(getConfigPath(), {});
    const cfg = raw.systemPulse && typeof raw.systemPulse === 'object' ? raw.systemPulse : {};
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch (_) {
    return { ...DEFAULT_CONFIG };
  }
}

export function isPulseEnabled() {
  return loadPulseConfig().enabled !== false;
}

function isDryRun() {
  if (process.env.PASTURE_PULSE_DRY_RUN === '1' || process.argv.includes('--pulse-dry-run')) return true;
  return loadPulseConfig().dryRun === true;
}

function localDateStr(ts = Date.now()) {
  const tz = getResolvedTimezone();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function localDateStrings() {
  const now = new Date();
  const today = localDateStr(now.getTime());
  const yesterday = localDateStr(now.getTime() - 86400000);
  return [yesterday, today];
}

// ---------------------------------------------------------------------------
// Health check (cheap, no LLM)
// ---------------------------------------------------------------------------

function parseDaemonLogErrors(logPath, maxLines = 1000) {
  if (!existsSync(logPath)) return [];
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-maxLines);
    return lines;
  } catch (_) {
    return [];
  }
}

function firstExistingPath(paths) {
  return paths.find((p) => p && existsSync(p)) || '';
}

function daemonLogPath() {
  const stateDir = getStateDir();
  return firstExistingPath([
    getCurrentDaemonLogPath(stateDir),
    getDailyDaemonLogPath(stateDir),
    join(stateDir, 'daemon.log'),
  ]);
}

function daemonErrPath() {
  const stateDir = getStateDir();
  return firstExistingPath([
    getCurrentDaemonErrPath(stateDir),
    getDailyDaemonErrPath(stateDir),
    join(stateDir, 'daemon.err'),
  ]);
}

function countRepeatedErrors(lines) {
  const counts = new Map();
  for (const line of lines) {
    const match = line.match(/\[(.*?)\]\s*(.*)/);
    if (!match) continue;
    const detail = match[2].replace(/\(attempt \d+\/\d+\)\s*/g, '').slice(0, 80);
    const key = match[1] + ': ' + detail;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .filter(([, count]) => count >= 3)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

function checkCronHealth() {
  const storePath = getCronStorePath();
  if (!existsSync(storePath)) return { status: 'ok', detail: 'no cron store' };
  try {
    const store = readJson(storePath, { jobs: [] });
    const jobs = Array.isArray(store.jobs) ? store.jobs : [];
    const failing = jobs.filter((j) => j.lastError || j.failCount > 0);
    if (failing.length === 0) return { status: 'ok', detail: `${jobs.length} jobs, none failing` };
    return {
      status: failing.length >= 3 ? 'critical' : 'warning',
      detail: `${failing.length}/${jobs.length} cron jobs failing`,
      failing: failing.slice(0, 5).map((j) => ({ name: j.name || j.id, failCount: j.failCount, lastError: (j.lastError || '').slice(0, 100) })),
    };
  } catch (_) {
    return { status: 'ok', detail: 'cron store unreadable' };
  }
}

function checkDiskUsage() {
  const stateDir = getStateDir();
  const workspaceDir = getWorkspaceDir();
  let totalBytes = 0;
  const countDir = (dir) => {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) countDir(p);
        else {
          try { totalBytes += statSync(p).size; } catch (_) {}
        }
      }
    } catch (_) {}
  };
  countDir(stateDir);
  countDir(workspaceDir);
  const mb = Math.round(totalBytes / 1024 / 1024);
  if (mb > 500) return { status: 'warning', detail: `${mb}MB total state+workspace`, mb };
  return { status: 'ok', detail: `${mb}MB total`, mb };
}

/**
 * Returns true if a successful LLM call appears in the daemon log within the last `withinMs`.
 * Timestamps in daily-logs/runtime/YYYY-MM-DD.log are UTC ISO strings like [2026-06-14T12:31:28].
 */
function hasRecentLlmActivity(withinMs = 20 * 60_000) {
  const logPath = daemonLogPath();
  if (!existsSync(logPath)) return false;
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').slice(-300);
    const cutoff = Date.now() - withinMs;
    for (const line of lines) {
      if (!line.includes('[LLM] used:')) continue;
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\]/);
      if (m && new Date(m[1] + 'Z').getTime() >= cutoff) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function checkLlmReachability() {
  // Skip the ping if real LLM calls have succeeded recently — the system is clearly reachable.
  if (hasRecentLlmActivity()) {
    return { status: 'ok', detail: 'LLM reachable (recent activity)', latencyMs: 0 };
  }
  try {
    const start = Date.now();
    const reply = await llmChat(
      [{ role: 'user', content: 'Reply with exactly: ok' }],
      {},
    );
    const latencyMs = Date.now() - start;
    const ok = typeof reply === 'string' && reply.toLowerCase().includes('ok');
    return { status: ok ? 'ok' : 'warning', detail: ok ? `LLM reachable (${latencyMs}ms)` : 'LLM replied but unexpected', latencyMs };
  } catch (err) {
    return { status: 'critical', detail: `LLM unreachable: ${(err.message || '').slice(0, 100)}` };
  }
}

function checkTransportLastActivity() {
  const logPath = daemonLogPath();
  if (!existsSync(logPath)) return { status: 'ok', detail: 'no daemon log' };
  try {
    const content = readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-500);
    const pollingRestarts = lines.filter((l) => l.includes('No poll activity')).length;
    const actualMessages = lines.filter((l) => l.includes('[message]') || l.includes('[telegram]') || l.includes('[wa]')).length;
    if (pollingRestarts > 10 && actualMessages === 0) {
      return { status: 'warning', detail: `${pollingRestarts} polling restarts, 0 actual messages in recent log` };
    }
    return { status: 'ok', detail: `${actualMessages} messages, ${pollingRestarts} poll restarts` };
  } catch (_) {
    return { status: 'ok', detail: 'log unreadable' };
  }
}

export async function runHealthCheck() {
  const errPath = daemonErrPath();

  const errLines = parseDaemonLogErrors(errPath);
  const repeatedErrors = countRepeatedErrors(errLines);
  const cron = checkCronHealth();
  const disk = checkDiskUsage();
  const transport = checkTransportLastActivity();
  const llm = await checkLlmReachability();

  const checks = { repeatedErrors, cron, disk, transport, llm, checkedAt: Date.now() };
  writeJson(getHealthPath(), checks);

  const flags = [];
  if (llm.status === 'critical') flags.push({ severity: 'critical', message: llm.detail });
  if (cron.status !== 'ok') flags.push({ severity: cron.status, message: cron.detail });
  if (transport.status !== 'ok') flags.push({ severity: transport.status, message: transport.detail });
  if (disk.status !== 'ok') flags.push({ severity: disk.status, message: disk.detail });
  if (repeatedErrors.length > 0) {
    const top = repeatedErrors[0];
    flags.push({ severity: 'warning', message: `Repeated error (${top.count}x): ${top.pattern}` });
  }

  const cfg = loadPulseConfig();
  if (cfg.healthNotify && flags.length > 0) {
    pendingHealthFlags = flags;
  }

  console.log('[system-pulse] Health check:', flags.length ? flags.map((f) => `[${f.severity}] ${f.message}`).join('; ') : 'all ok');
  return checks;
}

// ---------------------------------------------------------------------------
// Output pattern detection (LLM-powered)
// ---------------------------------------------------------------------------

function sampleRecentExchanges(workspaceDir, maxSamples = 20) {
  const dates = localDateStrings();
  const chatDays = readChatLogsForLocalDates(workspaceDir, dates, {});
  const all = [];
  for (const day of chatDays) {
    for (const ex of day.exchanges || []) {
      all.push(ex);
    }
  }

  const scored = all.map((ex) => {
    let priority = 0;
    const reply = String(ex.assistant || '');
    if (reply.length > 500) priority += 2;
    if (reply.includes('```')) priority += 3;
    if (ex.skillsCalled?.length > 0) priority += 1;
    const retro = ex.retrospective || {};
    if (retro.needsCorrection) priority += 4;
    if (typeof retro.selfScore === 'number' && retro.selfScore <= 6) priority += 2;
    return { ex, priority };
  });

  return scored
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxSamples)
    .map((s) => s.ex);
}

function formatExchangesForReview(exchanges) {
  return exchanges.map((ex, i) => {
    const skills = Array.isArray(ex.skillsCalled) && ex.skillsCalled.length ? ` [skills: ${ex.skillsCalled.join(', ')}]` : '';
    return `### Exchange ${i + 1}${skills}\nUser: ${String(ex.user || '').slice(0, 300)}\nAssistant: ${String(ex.assistant || '').slice(0, 600)}`;
  }).join('\n\n');
}

function readEditHistory() {
  return readJson(getPulseStatePath(), { editHistory: [] });
}

function writeEditHistory(state) {
  writeJson(getPulseStatePath(), state);
}

function canEditFile(filePath) {
  const state = readEditHistory();
  const history = Array.isArray(state.editHistory) ? state.editHistory : [];
  const cutoff = Date.now() - 48 * 60 * 60_000;
  const recentEdits = history.filter((e) => e.file === filePath && e.ts > cutoff);
  return recentEdits.length < MAX_EDITS_PER_FILE_48H;
}

function recordEdit(filePath, rationale) {
  const state = readEditHistory();
  state.editHistory = Array.isArray(state.editHistory) ? state.editHistory : [];
  state.editHistory.push({ file: filePath, ts: Date.now(), rationale: String(rationale || '').slice(0, 200) });
  state.editHistory = state.editHistory.filter((e) => e.ts > Date.now() - 7 * 86400000);
  writeEditHistory(state);
}

function backupFile(filePath) {
  if (!existsSync(filePath)) return;
  const name = basenameAnyPath(filePath);
  const dest = join(getBackupsDir(), `${name}.${Date.now()}`);
  copyFileSync(filePath, dest);
  return dest;
}

function logSelfEdit(filePath, oldText, newText, rationale, confidence) {
  const entry = [
    `--- ${new Date().toISOString()} ---`,
    `File: ${filePath}`,
    `Confidence: ${confidence}`,
    `Rationale: ${rationale}`,
    `Before (${oldText.length} chars):`,
    oldText.slice(0, 500),
    `After (${newText.length} chars):`,
    newText.slice(0, 500),
    '---\n',
  ].join('\n');
  const logPath = getSelfEditsLogPath();
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  refreshCurrentSelfEditsLink(dir, basename(logPath));
  appendFileSync(logPath, entry, 'utf8');
}

export async function runOutputPatternCheck() {
  const cfg = loadPulseConfig();
  const workspaceDir = getWorkspaceDir();
  const samples = sampleRecentExchanges(workspaceDir);
  if (samples.length < 3) {
    console.log('[system-pulse] Pattern check: too few exchanges to analyze');
    return { skipped: true, reason: 'too few exchanges' };
  }

  const exchangeBlock = formatExchangesForReview(samples);
  const soulPath = join(workspaceDir, 'SOUL.md');
  const currentSoul = existsSync(soulPath) ? readFileSync(soulPath, 'utf8') : '';

  const parsed = await runMdPrompt({
    promptName: 'system-pulse-pattern-detector',
    user: {
      currentSoul: currentSoul.slice(0, 2000),
      recentExchanges: exchangeBlock,
      maxPatterns: cfg.maxPatternsPerRun,
    },
    purpose: 'system_pulse_pattern_detector',
  });
  if (!parsed) {
    console.log('[system-pulse] Pattern check LLM failed (no parsed result)');
    return { ok: false, error: 'pattern detector LLM returned no result' };
  }
  const patterns = Array.isArray(parsed.patterns) ? parsed.patterns.slice(0, cfg.maxPatternsPerRun) : [];

  if (patterns.length === 0) {
    console.log('[system-pulse] Pattern check: no actionable patterns found');
    return { ok: true, patterns: 0 };
  }

  const applied = [];
  for (const pattern of patterns) {
    const targetFile = resolvePatternFile(workspaceDir, pattern.file);
    if (!targetFile || !existsSync(targetFile)) {
      console.log('[system-pulse] Skipping pattern — file not found:', pattern.file);
      continue;
    }
    if (!canEditFile(targetFile)) {
      console.log('[system-pulse] Skipping pattern — edit cap reached for:', pattern.file);
      continue;
    }

    const critiqueOk = await selfCritiqueEdit(pattern, currentSoul, cfg.selfEditConfidenceThreshold);
    if (!critiqueOk.approved) {
      console.log('[system-pulse] Self-critique rejected edit:', critiqueOk.reason);
      continue;
    }

    if (isDryRun()) {
      console.log('[system-pulse] DRY RUN — would edit', pattern.file, ':', pattern.rationale);
      applied.push({ file: pattern.file, rationale: pattern.rationale, dryRun: true });
      continue;
    }

    const oldContent = readFileSync(targetFile, 'utf8');
    let newContent;
    if (pattern.action === 'replace' && pattern.oldText) {
      if (!oldContent.includes(pattern.oldText)) {
        console.log('[system-pulse] Replace target not found in', pattern.file);
        continue;
      }
      newContent = oldContent.replace(pattern.oldText, pattern.newText);
    } else {
      const dateComment = `\n<!-- pulse ${localDateStr()}: ${(pattern.rationale || '').slice(0, 60)} -->`;
      newContent = oldContent.trimEnd() + dateComment + '\n' + pattern.newText.trim() + '\n';
    }

    backupFile(targetFile);
    writeFileSync(targetFile, newContent, 'utf8');
    logSelfEdit(targetFile, oldContent, newContent, pattern.rationale, critiqueOk.confidence);
    recordEdit(targetFile, pattern.rationale);
    applied.push({ file: pattern.file, rationale: pattern.rationale });
    console.log('[system-pulse] Applied self-edit to', pattern.file, '—', pattern.rationale);
  }

  return { ok: true, patterns: patterns.length, applied: applied.length, edits: applied };
}

function resolvePatternFile(workspaceDir, fileRef) {
  if (!fileRef) return null;
  const ref = String(fileRef).trim();
  if (ref === 'SOUL.md') return join(workspaceDir, 'SOUL.md');
  if (ref.startsWith('skills/')) {
    const installDir = process.env.PASTURE_INSTALL_DIR || join(__dirname, '..');
    return join(installDir, ref);
  }
  return null;
}

async function selfCritiqueEdit(pattern, currentSoul, threshold) {
  const parsed = await runMdPrompt({
    promptName: 'system-pulse-self-critique',
    user: {
      edit: {
        file: pattern.file,
        action: pattern.action,
        oldText: (pattern.oldText || '').slice(0, 200),
        newText: (pattern.newText || '').slice(0, 300),
        rationale: pattern.rationale || '',
      },
      currentSoul: (currentSoul || '').slice(0, 1000),
    },
    purpose: 'system_pulse_self_critique',
  });
  if (!parsed) {
    return { approved: false, confidence: 0, reason: 'critique LLM returned no result' };
  }
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  return {
    approved: parsed.approved === true && confidence >= threshold,
    confidence,
    reason: String(parsed.reason || '').slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Pending health flags (consumed by reply path)
// ---------------------------------------------------------------------------

export function getPendingHealthFlags() {
  if (pendingHealthFlags.length === 0) return '';
  const cfg = loadPulseConfig();
  if (!cfg.healthNotify) return '';
  const msgs = pendingHealthFlags
    .filter((f) => f.severity === 'warning' || f.severity === 'critical')
    .map((f) => f.message);
  pendingHealthFlags = [];
  if (msgs.length === 0) return '';
  return 'Heads up: ' + msgs.join('; ') + '.';
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

async function runHealthIfDue() {
  if (isDailyLimitReached()) return;
  const trace = startRequestTrace({ source: 'health_check', agentId: 'system' });
  await runWithRequestTrace(trace, async () => {
    logRequestStart(trace);
    try {
      await traceAsyncStep('health_check', () => runHealthCheck());
      logRequestEnd(trace, 'ok');
    } catch (err) {
      console.error('[system-pulse] Health check error:', err.message || err);
      logRequestEnd(trace, 'error', { error: err.message });
    }
  });
}

async function runPatternIfDue() {
  if (isDailyLimitReached()) return;
  const state = readEditHistory();
  const lastRun = Number(state.lastPatternCheckAt) || 0;
  const cfg = loadPulseConfig();
  const intervalMs = cfg.patternIntervalHours * 60 * 60_000;
  if (Date.now() - lastRun < intervalMs) return;

  const trace = startRequestTrace({ source: 'pattern_check', agentId: 'system' });
  await runWithRequestTrace(trace, async () => {
    logRequestStart(trace);
    try {
      const result = await traceAsyncStep('pattern_check', () => runOutputPatternCheck());
      const s = readEditHistory();
      s.lastPatternCheckAt = Date.now();
      writeEditHistory(s);
      logRequestEnd(trace, 'ok');
      return result;
    } catch (err) {
      console.error('[system-pulse] Pattern check error:', err.message || err);
      logRequestEnd(trace, 'error', { error: err.message });
    }
  });
}

export function startSystemPulse() {
  if (!isPulseEnabled()) {
    console.log('[system-pulse] Disabled via config.');
    return;
  }
  const cfg = loadPulseConfig();
  stopSystemPulse();

  const healthMs = Math.max(5 * 60_000, cfg.healthIntervalMinutes * 60_000);
  healthTimer = setInterval(() => {
    runHealthIfDue().catch(() => {});
  }, healthMs);

  const patternMs = Math.max(60 * 60_000, cfg.patternIntervalHours * 60 * 60_000);
  patternTimer = setInterval(() => {
    runPatternIfDue().catch(() => {});
  }, patternMs);

  console.log(`[system-pulse] Started — health every ${cfg.healthIntervalMinutes}m, patterns every ${cfg.patternIntervalHours}h${isDryRun() ? ' (DRY RUN)' : ''}`);
}

export function stopSystemPulse() {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (patternTimer) { clearInterval(patternTimer); patternTimer = null; }
}
