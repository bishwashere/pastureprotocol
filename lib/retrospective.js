/**
 * Retrospective subsystem (always-on, hidden from skills UI like Tide).
 * 1. After each exchange: self-score via lightweight LLM call.
 * 2. On next user message: implicit feedback (correction / pushback).
 * 3. Nightly + weekly: reflector agent extracts lessons from bad cases.
 * 4. lessons.md injected in system prompt; bad cases vector-indexed for retrieval.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { chat as llmChat } from '../llm.js';
import { stripThinking } from './agent.js';
import { runAgentTurn } from './agent.js';
import { getSkillContext } from '../skills/loader.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import {
  getConfigPath,
  getCronStorePath,
  getWorkspaceDir,
  getRetrospectiveMetricsPath,
  getRetrospectiveLastRunPath,
  RETROSPECTIVE_BAD_CASES_REL,
  getAgentWorkspaceDir,
} from './paths.js';
import {
  patchExchangeRetrospective,
  getLastPrivateExchangeLocation,
} from './chat-log.js';
import { search, indexCustomChunk } from './memory-index.js';
import { getMemoryConfig } from './memory-config.js';
import { getResolvedTimezone } from './timezone.js';
import { createAgent, loadAgentConfig, saveAgentConfig, listAgentIds, REFLECTOR_AGENT_ID } from './agent-config.js';
import { getOwnerLogJid } from './owner-config.js';

export { REFLECTOR_AGENT_ID } from './agent-config.js';
export const LESSONS_MD = 'lessons.md';
const BAD_CHUNK_TYPE = 'retrospective-bad';

const DEFAULT_CONFIG = {
  enabled: true,
  reflectorAgentId: REFLECTOR_AGENT_ID,
  lowScoreThreshold: 6,
  lookbackDays: 7,
  nightlyHour: 2,
  weeklyDay: 0,
  weeklyHour: 3,
};

const REFLECTOR_SOUL = `# Reflector
You analyze conversation failures and extract durable, actionable lessons.
Be concise. Focus on behavior change, not blame.`;

const REFLECTION_INSTRUCTION = `

# Retrospective reflection (internal)
You are the reflector agent. Review the bad conversation cases below.
Extract clear lessons for the main assistant.

Respond with JSON only (no markdown fences):
{
  "stopDoing": ["..."],
  "startDoing": ["..."],
  "rules": ["short imperative rules to append to lessons.md"]
}

Then use the write or edit skill to append a dated section to lessons.md if rules are non-empty.
Do not message the user.`;

const SKIP_USER_PREFIXES = ['tide check', '[tide', '[retrospective'];

let retrospectiveInterval = null;
let scoringQueue = Promise.resolve();

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

function loadRootConfig() {
  return readJson(getConfigPath(), {});
}

export function getRetrospectiveConfig(config = loadRootConfig()) {
  const raw = config.retrospective && typeof config.retrospective === 'object' ? config.retrospective : {};
  return { ...DEFAULT_CONFIG, ...raw };
}

export function isRetrospectiveEnabled(config = loadRootConfig()) {
  return getRetrospectiveConfig(config).enabled !== false;
}

/** Ensure config.retrospective block exists (hidden default, always on). */
export function migrateRetrospectiveConfig() {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return;
    const config = readJson(path, {});
    if (config.retrospective != null && typeof config.retrospective === 'object') return;
    config.retrospective = { ...DEFAULT_CONFIG };
    writeJson(path, config);
  } catch (_) {}
}

export function ensureReflectorAgent() {
  if (!listAgentIds().includes(REFLECTOR_AGENT_ID)) {
    createAgent(REFLECTOR_AGENT_ID, { title: 'Reflector', fromAgentId: 'main' });
  }
  const ws = getAgentWorkspaceDir(REFLECTOR_AGENT_ID);
  const soulPath = join(ws, 'SOUL.md');
  if (!existsSync(soulPath) || !readFileSync(soulPath, 'utf8').trim()) {
    writeFileSync(soulPath, REFLECTOR_SOUL, 'utf8');
  }
  const cfg = loadAgentConfig(REFLECTOR_AGENT_ID);
  cfg.skills = cfg.skills || {};
  cfg.skills.enabled = ['read', 'write', 'edit', 'memory'];
  saveAgentConfig(REFLECTOR_AGENT_ID, cfg);
}

function shouldSkipUserText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  return SKIP_USER_PREFIXES.some((p) => t === p || t.startsWith(p));
}

function parseJsonFromLlm(raw) {
  const cleaned = stripThinking(raw || '')
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function scoreExchangeWithLlm(exchange) {
  const user = String(exchange.user || '').slice(0, 800);
  const assistant = String(exchange.assistant || '').slice(0, 1200);
  const prompt =
    `Rate the assistant's reply quality for this exchange (1=bad, 10=excellent).\n` +
    `User: ${user}\nAssistant: ${assistant}\n\n` +
    `Return JSON only: {"score": number, "reason": "one sentence"}`;
  const raw = await llmChat(
    [
      { role: 'system', content: 'Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    {},
  );
  const parsed = parseJsonFromLlm(raw);
  const score = Math.max(1, Math.min(10, Math.round(Number(parsed.score) || 5)));
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 500) : '';
  return { selfScore: score, selfReason: reason, scoredAt: Date.now() };
}

async function analyzeImplicitFeedbackWithLlm(prevExchange, nextUserMessage) {
  const prompt =
    `Previous user message:\n${String(prevExchange.user || '').slice(0, 600)}\n\n` +
    `Assistant reply:\n${String(prevExchange.assistant || '').slice(0, 900)}\n\n` +
    `User's NEXT message (implicit feedback):\n${String(nextUserMessage || '').slice(0, 600)}\n\n` +
    `Classify the next message as feedback on the assistant reply.\n` +
    `Return JSON only:\n` +
    `{"feedbackType":"correction|pushback|neutral|positive","needsCorrection":boolean,"summary":"one sentence"}`;
  const raw = await llmChat(
    [
      { role: 'system', content: 'Return only valid JSON.' },
      { role: 'user', content: prompt },
    ],
    {},
  );
  const parsed = parseJsonFromLlm(raw);
  const feedbackType = ['correction', 'pushback', 'neutral', 'positive'].includes(parsed.feedbackType)
    ? parsed.feedbackType
    : 'neutral';
  const needsCorrection = parsed.needsCorrection === true || feedbackType === 'correction' || feedbackType === 'pushback';
  return {
    feedbackType,
    needsCorrection,
    implicitFeedback: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 500) : '',
    feedbackAt: Date.now(),
  };
}

export function readQualityMetrics() {
  return readJson(getRetrospectiveMetricsPath(), {
    totalScored: 0,
    totalWithFeedback: 0,
    corrections: 0,
    correctionRate: 0,
    daily: {},
    history: [],
  });
}

export function updateQualityMetrics(patch) {
  const metrics = readQualityMetrics();
  const next = { ...metrics, ...patch };
  if (next.totalWithFeedback > 0) {
    next.correctionRate = Number((next.corrections / next.totalWithFeedback).toFixed(4));
  }
  writeJson(getRetrospectiveMetricsPath(), next);
  return next;
}

export function recordScoredExchange(dateStr) {
  const metrics = readQualityMetrics();
  metrics.daily = metrics.daily || {};
  const day = metrics.daily[dateStr] || { scored: 0, corrections: 0, feedback: 0 };
  day.scored += 1;
  metrics.daily[dateStr] = day;
  metrics.totalScored = (metrics.totalScored || 0) + 1;
  writeJson(getRetrospectiveMetricsPath(), metrics);
}

export function recordImplicitFeedback(dateStr, needsCorrection) {
  const metrics = readQualityMetrics();
  metrics.daily = metrics.daily || {};
  const day = metrics.daily[dateStr] || { scored: 0, corrections: 0, feedback: 0 };
  day.feedback = (day.feedback || 0) + 1;
  if (needsCorrection) day.corrections += 1;
  metrics.daily[dateStr] = day;
  metrics.totalWithFeedback = (metrics.totalWithFeedback || 0) + 1;
  if (needsCorrection) metrics.corrections = (metrics.corrections || 0) + 1;
  if (metrics.totalWithFeedback > 0) {
    metrics.correctionRate = Number((metrics.corrections / metrics.totalWithFeedback).toFixed(4));
  }
  writeJson(getRetrospectiveMetricsPath(), metrics);
}

function localDateStr(ts = Date.now()) {
  const tz = getResolvedTimezone();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

export function appendToLessonsMd(workspaceDir, sectionMarkdown) {
  if (!workspaceDir || !sectionMarkdown) return;
  const p = join(workspaceDir, LESSONS_MD);
  const header = existsSync(p) ? '\n\n' : '# Lessons\n\n';
  appendFileSync(p, header + sectionMarkdown.trim() + '\n', 'utf8');
}

function appendBadCaseRecord(workspaceDir, record) {
  const dir = join(workspaceDir, 'retrospective');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const relPath = RETROSPECTIVE_BAD_CASES_REL;
  const line = JSON.stringify(record) + '\n';
  appendFileSync(join(workspaceDir, relPath), line, 'utf8');
  const content = readFileSync(join(workspaceDir, relPath), 'utf8');
  const lineNumber = content.split('\n').filter((l) => l.trim()).length;
  return { relPath, lineNumber };
}

async function indexBadCase(memoryConfig, workspaceDir, record) {
  if (!memoryConfig) return;
  const { relPath, lineNumber } = appendBadCaseRecord(workspaceDir, record);
  const text =
    `Bad case (${record.feedbackType || 'low-score'})\n` +
    `User: ${record.user || ''}\n` +
    `Assistant: ${record.assistant || ''}\n` +
    `Feedback: ${record.implicitFeedback || record.selfReason || ''}\n` +
    `Lesson context: score=${record.selfScore}`;
  await indexCustomChunk(memoryConfig, {
    relPath,
    lineNumber,
    text,
    type: BAD_CHUNK_TYPE,
    chunkDate: record.date || localDateStr(),
  });
}

/**
 * After a private exchange is logged — queue self-score (non-blocking).
 */
export function afterExchangeLogged(workspaceDir, exchange, logMeta = null) {
  if (!isRetrospectiveEnabled() || !workspaceDir || !exchange) return;
  if (shouldSkipUserText(exchange.user)) return;
  scoringQueue = scoringQueue.then(async () => {
    try {
      let path = logMeta?.path;
      let lineNumber = logMeta?.lineNumber;
      if (!path || !lineNumber) {
        const loc = getLastPrivateExchangeLocation(workspaceDir, exchange.jid, exchange.sessionId);
        if (!loc) return;
        path = loc.path;
        lineNumber = loc.lineNumber;
      }
      const scorePatch = await scoreExchangeWithLlm(exchange);
      patchExchangeRetrospective(workspaceDir, path, lineNumber, scorePatch);
      recordScoredExchange(localDateStr(exchange.timestampMs || Date.now()));
      const cfg = getRetrospectiveConfig();
      if (scorePatch.selfScore <= cfg.lowScoreThreshold) {
        await indexBadCase(getMemoryConfig(), workspaceDir, {
          date: localDateStr(exchange.timestampMs),
          user: exchange.user,
          assistant: exchange.assistant,
          selfScore: scorePatch.selfScore,
          selfReason: scorePatch.selfReason,
          feedbackType: 'low-score',
          path,
          lineNumber,
        });
      }
    } catch (err) {
      console.log('[retrospective] score failed:', err.message || err);
    }
  }).catch(() => {});
}

/**
 * Before handling a new user message — attach implicit feedback to previous exchange.
 */
export async function beforeUserMessage(workspaceDir, logJid, sessionId, userText) {
  if (!isRetrospectiveEnabled() || !workspaceDir || !logJid || shouldSkipUserText(userText)) return;
  const loc = getLastPrivateExchangeLocation(workspaceDir, logJid, sessionId);
  if (!loc || !loc.row) return;
  if (loc.row.retrospective?.feedbackAt) return;
  try {
    const feedback = await analyzeImplicitFeedbackWithLlm(loc.row, userText);
    patchExchangeRetrospective(workspaceDir, loc.path, loc.lineNumber, {
      ...feedback,
      nextUserMessage: String(userText || '').slice(0, 500),
    });
    recordImplicitFeedback(localDateStr(), feedback.needsCorrection);
    if (feedback.needsCorrection) {
      await indexBadCase(getMemoryConfig(), workspaceDir, {
        date: localDateStr(loc.row.ts),
        user: loc.row.user,
        assistant: loc.row.assistant,
        selfScore: loc.row.retrospective?.selfScore,
        selfReason: loc.row.retrospective?.selfReason,
        implicitFeedback: feedback.implicitFeedback,
        nextUserMessage: userText,
        feedbackType: feedback.feedbackType,
        path: loc.path,
        lineNumber: loc.lineNumber,
      });
    }
  } catch (err) {
    console.log('[retrospective] implicit feedback failed:', err.message || err);
  }
}

/**
 * Similar bad-case retrieval block for system prompt injection.
 */
export async function buildRetrospectiveContextBlock(userText, memoryConfig) {
  if (!isRetrospectiveEnabled() || !memoryConfig || !userText || shouldSkipUserText(userText)) return '';
  try {
    const hits = await search(String(userText).slice(0, 400), {
      ...memoryConfig,
      search: {
        ...(memoryConfig.search || {}),
        maxResults: 3,
        minScore: 0.35,
        type: BAD_CHUNK_TYPE,
      },
    });
    if (!hits.length) return '';
    const lines = hits.map((h, i) => `${i + 1}. (${(h.score * 100).toFixed(0)}%) ${h.snippet}`).join('\n');
    return `\n\n# Similar past mistakes (retrospective)\nAvoid repeating these patterns:\n${lines}`;
  } catch (_) {
    return '';
  }
}

/** Collect exchanges needing reflection (low score or correction, not yet reflected). */
export function collectBadExchanges(workspaceDir, lookbackDays = 7, lowScoreThreshold = 6) {
  const cutoff = Date.now() - lookbackDays * 86400000;
  const bad = [];
  const privDir = join(workspaceDir, 'chat-log', 'private');
  if (!existsSync(privDir)) return bad;
  let files = [];
  try {
    files = readdirSync(privDir).filter((f) => f.endsWith('.jsonl'));
  } catch (_) {
    return bad;
  }
  for (const file of files) {
    const relPath = `chat-log/private/${file}`;
    let lines = [];
    try {
      lines = readFileSync(join(workspaceDir, relPath), 'utf8').split('\n').filter((l) => l.trim());
    } catch (_) {
      continue;
    }
    lines.forEach((line, i) => {
      let row;
      try { row = JSON.parse(line); } catch (_) { return; }
      if (!row || typeof row.ts !== 'number' || row.ts < cutoff) return;
      const retro = row.retrospective || {};
      if (retro.reflected) return;
      const low = typeof retro.selfScore === 'number' && retro.selfScore <= lowScoreThreshold;
      const corrected = retro.needsCorrection === true;
      if (!low && !corrected) return;
      bad.push({ path: relPath, lineNumber: i + 1, row, retrospective: retro });
    });
  }
  return bad.slice(0, 20);
}

function formatBadCasesForReflector(cases) {
  return cases.map((c, i) => {
    const r = c.retrospective || {};
    return (
      `### Case ${i + 1}\n` +
      `Score: ${r.selfScore ?? '?'} | Feedback: ${r.feedbackType || 'low-score'}\n` +
      `User: ${String(c.row.user || '').slice(0, 400)}\n` +
      `Assistant: ${String(c.row.assistant || '').slice(0, 600)}\n` +
      `Implicit: ${r.implicitFeedback || r.selfReason || ''}\n` +
      `Next user: ${r.nextUserMessage || ''}`
    );
  }).join('\n\n');
}

async function runReflectionJob(period) {
  if (!isRetrospectiveEnabled()) return { skipped: true, reason: 'disabled' };
  ensureReflectorAgent();
  const cfg = getRetrospectiveConfig();
  const workspaceDir = getWorkspaceDir();
  const cases = collectBadExchanges(workspaceDir, cfg.lookbackDays, cfg.lowScoreThreshold);
  if (!cases.length) {
    console.log('[retrospective]', period, '— no bad cases to reflect on');
    return { skipped: true, reason: 'no cases', cases: 0 };
  }
  console.log('[retrospective]', period, '— reflecting on', cases.length, 'case(s)');

  const bootstrap = buildSessionBootstrapContext(workspaceDir, { logJid: getOwnerLogJid() }).block;
  const basePrompt = buildOneOnOneSystemPrompt(workspaceDir) + (bootstrap || '') + REFLECTION_INSTRUCTION;
  const { runSkillTool, getFullSkillDoc, resolveToolName } = getSkillContext({ agentId: cfg.reflectorAgentId });
  const tools = Array.isArray(runSkillTool) && runSkillTool.length ? runSkillTool : [];
  const noop = () => {};
  const ctx = {
    storePath: getCronStorePath(),
    jid: 'retrospective-reflector',
    workspaceDir,
    agentId: cfg.reflectorAgentId,
    scheduleOneShot: noop,
    startCron: noop,
    groupNonOwner: false,
  };

  const userText =
    `[Retrospective ${period}] Review these ${cases.length} bad conversation case(s) and extract lessons.\n\n` +
    formatBadCasesForReflector(cases);

  let textToSend = '';
  try {
    const turn = await runAgentTurn({
      userText,
      ctx,
      systemPrompt: basePrompt,
      tools,
      historyMessages: [],
      getFullSkillDoc,
      resolveToolName,
    });
    textToSend = (turn?.textToSend || '').trim();
  } catch (err) {
    console.error('[retrospective] reflector failed:', err.message || err);
    return { ok: false, error: err.message, cases: cases.length };
  }

  let parsed = null;
  try {
    parsed = parseJsonFromLlm(textToSend);
  } catch (_) {}

  const dateLabel = localDateStr();
  if (parsed && (parsed.rules?.length || parsed.stopDoing?.length || parsed.startDoing?.length)) {
    const section =
      `## ${dateLabel} (${period} retrospective)\n\n` +
      (parsed.stopDoing?.length ? `### Stop doing\n${parsed.stopDoing.map((x) => `- ${x}`).join('\n')}\n\n` : '') +
      (parsed.startDoing?.length ? `### Start doing\n${parsed.startDoing.map((x) => `- ${x}`).join('\n')}\n\n` : '') +
      (parsed.rules?.length ? `### Rules\n${parsed.rules.map((x) => `- ${x}`).join('\n')}` : '');
    appendToLessonsMd(workspaceDir, section);
  }

  for (const c of cases) {
    patchExchangeRetrospective(workspaceDir, c.path, c.lineNumber, {
      reflected: true,
      reflectedAt: Date.now(),
      reflectPeriod: period,
    });
  }

  const metrics = readQualityMetrics();
  metrics.history = Array.isArray(metrics.history) ? metrics.history : [];
  metrics.history.push({
    date: dateLabel,
    period,
    correctionRate: metrics.correctionRate,
    casesReviewed: cases.length,
  });
  metrics.history = metrics.history.slice(-90);
  writeJson(getRetrospectiveMetricsPath(), metrics);

  writeJson(getRetrospectiveLastRunPath(), {
    ...(readJson(getRetrospectiveLastRunPath(), {})),
    [period]: Date.now(),
  });

  console.log('[retrospective]', period, 'complete — correction rate:', metrics.correctionRate);
  return { ok: true, cases: cases.length, correctionRate: metrics.correctionRate };
}

function localHourAndDay() {
  const tz = getResolvedTimezone();
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const weekday = parts.find((p) => p.type === 'weekday')?.value || '';
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hour, day: dayMap[weekday] ?? 0, dateStr: localDateStr(now.getTime()) };
}

export async function runScheduledRetrospectiveIfDue() {
  if (!isRetrospectiveEnabled()) return;
  const cfg = getRetrospectiveConfig();
  const { hour, day, dateStr } = localHourAndDay();
  const last = readJson(getRetrospectiveLastRunPath(), {});

  if (hour === cfg.nightlyHour && last.nightlyDate !== dateStr) {
    await runReflectionJob('nightly');
    writeJson(getRetrospectiveLastRunPath(), { ...last, nightly: Date.now(), nightlyDate: dateStr });
  }

  if (day === cfg.weeklyDay && hour === cfg.weeklyHour && last.weeklyDate !== dateStr) {
    await runReflectionJob('weekly');
    writeJson(getRetrospectiveLastRunPath(), { ...last, weekly: Date.now(), weeklyDate: dateStr });
  }
}

export function startRetrospective() {
  if (!isRetrospectiveEnabled()) {
    console.log('[retrospective] Disabled via config.');
    return;
  }
  migrateRetrospectiveConfig();
  ensureReflectorAgent();
  if (retrospectiveInterval) clearInterval(retrospectiveInterval);
  retrospectiveInterval = setInterval(() => {
    runScheduledRetrospectiveIfDue().catch((e) =>
      console.error('[retrospective] scheduler error:', e.message || e),
    );
  }, 15 * 60 * 1000);
  console.log('[retrospective] Enabled — self-score after replies; nightly/weekly reflection scheduled.');
}

export function stopRetrospective() {
  if (retrospectiveInterval) {
    clearInterval(retrospectiveInterval);
    retrospectiveInterval = null;
  }
}
