/**
 * Tide checklist: sequential LLM/agent turns (same path as chat and Tide follow-up).
 * Each item is one user message to runAgentTurn with full skills; results logged only (no DM).
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { getConfigPath, getCronStorePath, getStateDir, getWorkspaceDir, getEnvPath, ensureStateDir } from '../util/paths.js';
import { isInTideInactiveWindow } from '../util/timezone.js';
import { ensurePollingAlive } from '../channels/telegram.js';
import { buildSessionBootstrapContext } from './session-bootstrap.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { getOwnerLogJid } from '../util/owner-config.js';
import { getSkillContext } from '../../skills/loader.js';
import { runAgentTurn } from './agent.js';
import { isDailyLimitError } from '../../llm.js';
import { loadPrompt } from './md-llm.js';

dotenv.config({ path: getEnvPath() });

const DEFAULT_TRIGGERS = {
  onRestart: true,
  onCycle: true,
  onFollowUp: false,
};

// Loaded lazily so a missing template surfaces clearly at runtime.
function getChecklistInstruction() {
  return '\n\n' + loadPrompt('tide-checklist-instruction');
}

/** Migrate legacy shell/http/builtin config into a prompt string. */
function legacyItemToPrompt(it) {
  const type = String(it.type || '').toLowerCase();
  if (type === 'shell' && it.command) {
    return `Run this maintenance check via shell if needed: ${it.command}. Report OK or FAIL.`;
  }
  if (type === 'http' && it.url) {
    return `Verify this URL responds as expected (${it.url}, expected status ${it.expectStatus ?? 200}). Report OK or FAIL.`;
  }
  if ((type === 'file' || type === 'file_exists') && it.path) {
    return `Verify this path exists and is usable: ${it.path}. Report OK or FAIL.`;
  }
  if (type === 'builtin' && it.builtin === 'telegram_polling') {
    return 'Confirm Telegram bot polling is healthy. Report OK or FAIL.';
  }
  return '';
}

function normalizeItem(it) {
  const label = String(it.label || it.id || 'Check').trim();
  const prompt =
    (it.prompt != null && String(it.prompt).trim()) ||
    legacyItemToPrompt(it) ||
    label;
  return {
    id: String(it.id || '').trim() || slugFromLabel(label),
    label,
    prompt,
    enabled: it.enabled !== false,
  };
}

/**
 * @param {object} tide
 */
export function normalizeChecklistConfig(tide = {}) {
  const raw = tide.checklist && typeof tide.checklist === 'object' ? tide.checklist : {};
  const triggers = { ...DEFAULT_TRIGGERS, ...(raw.triggers && typeof raw.triggers === 'object' ? raw.triggers : {}) };
  const items = Array.isArray(raw.items)
    ? raw.items.filter((it) => it && typeof it === 'object').map(normalizeItem)
    : [];
  return {
    enabled: !!raw.enabled,
    triggers,
    items,
  };
}

function slugFromLabel(label) {
  const base = String(label || 'check')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return base || 'check';
}

function uniqueId(base, existing) {
  let id = base;
  let n = 2;
  while (existing.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function loadConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensureStateDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

export function getTideChecklistLastRunPath() {
  return join(getStateDir(), 'tide-checklist-last.json');
}

export function getTideChecklistFromConfig(config = loadConfig()) {
  return normalizeChecklistConfig(config.tide || {});
}

function getTideBlock(config) {
  config.tide = config.tide && typeof config.tide === 'object' ? config.tide : {};
  config.tide.checklist = normalizeChecklistConfig(config.tide);
  return config;
}

export function listChecklistItems() {
  return getTideChecklistFromConfig().items;
}

/**
 * @param {{ label: string, prompt?: string, enabled?: boolean }} opts
 */
export function addChecklistItem(opts) {
  const label = String(opts.label || '').trim();
  if (!label) return { ok: false, message: 'Label is required.' };

  const config = loadConfig();
  getTideBlock(config);
  const items = config.tide.checklist.items;
  const existingIds = new Set(items.map((i) => i.id));
  const id = uniqueId(slugFromLabel(label), existingIds);
  const prompt = (opts.prompt != null && String(opts.prompt).trim()) || label;
  const item = { id, label, prompt, enabled: opts.enabled !== false };

  items.push(item);
  saveConfig(config);
  return { ok: true, message: `Added checklist item "${id}" (${label}).`, id, item };
}

export function removeChecklistItem(id) {
  const safeId = String(id || '').trim();
  if (!safeId) return { ok: false, message: 'Item id is required.' };

  const config = loadConfig();
  getTideBlock(config);
  const items = config.tide.checklist.items;
  const idx = items.findIndex((i) => i.id === safeId);
  if (idx < 0) return { ok: false, message: `Checklist item "${safeId}" not found.` };

  items.splice(idx, 1);
  saveConfig(config);
  return { ok: true, message: `Removed checklist item "${safeId}".` };
}

export function setChecklistItemEnabled(id, enabled) {
  const safeId = String(id || '').trim();
  const config = loadConfig();
  getTideBlock(config);
  const item = config.tide.checklist.items.find((i) => i.id === safeId);
  if (!item) return { ok: false, message: `Checklist item "${safeId}" not found.` };
  item.enabled = !!enabled;
  saveConfig(config);
  return { ok: true, message: `${enabled ? 'Enabled' : 'Disabled'} checklist item "${safeId}".`, item };
}

export function setChecklistTriggers(patch) {
  const config = loadConfig();
  getTideBlock(config);
  const t = config.tide.checklist.triggers;
  if (patch.onRestart !== undefined) t.onRestart = !!patch.onRestart;
  if (patch.onCycle !== undefined) t.onCycle = !!patch.onCycle;
  if (patch.onFollowUp !== undefined) t.onFollowUp = !!patch.onFollowUp;
  saveConfig(config);
  return { ok: true, triggers: { ...t } };
}

export function setChecklistEnabled(enabled) {
  const config = loadConfig();
  getTideBlock(config);
  config.tide.checklist.enabled = !!enabled;
  saveConfig(config);
  return { ok: true, enabled: config.tide.checklist.enabled };
}

export function shouldRunChecklistForTrigger(trigger, opts = {}) {
  const config = opts.tide ? { tide: opts.tide } : loadConfig();
  const tide = config.tide || {};
  if (!tide.enabled) return false;
  const checklist = normalizeChecklistConfig(tide);
  if (!checklist.enabled) return false;
  if (!checklist.triggers[trigger]) return false;
  if (!opts.skipInactiveWindow) {
    const inactiveStart = tide.inactiveStart && String(tide.inactiveStart).trim();
    const inactiveEnd = tide.inactiveEnd && String(tide.inactiveEnd).trim();
    if (inactiveStart && inactiveEnd && isInTideInactiveWindow(inactiveStart, inactiveEnd)) return false;
  }
  return true;
}

function inferCheckOk(text, err) {
  if (err) return false;
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\s*FAIL\b/i.test(t)) return false;
  if (/(^|\n)\s*FAIL\s*:/i.test(t)) return false;
  return true;
}

/**
 * Run one checklist item through the same agent stack as chat.
 * @param {ReturnType<typeof normalizeItem>} item
 * @param {{ baseSystemPrompt: string, workspaceDir: string, storePath: string, priorResults: object[] }} runCtx
 */
async function runOneItemViaAgent(item, runCtx) {
  const started = Date.now();
  const { runSkillTool, getFullSkillDoc, resolveToolName } = getSkillContext();
  const toolsToUse = Array.isArray(runSkillTool) && runSkillTool.length > 0 ? runSkillTool : [];

  const historyMessages = [];
  for (const prev of runCtx.priorResults) {
    historyMessages.push({
      role: 'user',
      content: `[Prior checklist: ${prev.id}] ${prev.label}`,
    });
    historyMessages.push({
      role: 'assistant',
      content: String(prev.detail || prev.response || '').slice(0, 1500),
    });
  }

  const noop = () => {};
  const ctx = {
    storePath: runCtx.storePath,
    jid: 'tide-checklist',
    workspaceDir: runCtx.workspaceDir,
    scheduleOneShot: noop,
    startCron: noop,
    groupNonOwner: false,
  };

  const userText = `[Tide checklist · ${item.id}] ${item.prompt}`;

  let textToSend = '';
  let skillsCalled = [];
  let errMsg = null;
  try {
    const turn = await runAgentTurn({
      userText,
      ctx,
      systemPrompt: runCtx.baseSystemPrompt + getChecklistInstruction(),
      tools: toolsToUse,
      historyMessages,
      getFullSkillDoc,
      resolveToolName,
    });
    textToSend = (turn?.textToSend || '').trim();
    skillsCalled = Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [];
  } catch (e) {
    errMsg = e.message || String(e);
  }

  const ok = inferCheckOk(textToSend, errMsg);
  return {
    id: item.id,
    label: item.label,
    ok,
    detail: errMsg || textToSend.slice(0, 2000),
    response: textToSend.slice(0, 2000),
    skillsCalled,
    durationMs: Date.now() - started,
  };
}

/**
 * Run enabled checklist items one by one via the agent (same LLM/tools path as chat).
 * @param {{ telegramBot?: object, onlyIds?: string[], manual?: boolean, trigger?: string }} [ctx]
 */
export async function runTideChecklist(ctx = {}) {
  const config = loadConfig();
  const checklist = getTideChecklistFromConfig(config);
  if (!checklist.enabled && !ctx.manual) {
    return { skipped: true, reason: 'checklist disabled', results: [] };
  }

  let items = checklist.items.filter((i) => i.enabled);
  if (ctx.onlyIds?.length) {
    const set = new Set(ctx.onlyIds.map(String));
    items = items.filter((i) => set.has(i.id));
  }

  if (ctx.telegramBot) {
    await ensurePollingAlive(ctx.telegramBot).catch((e) =>
      console.error('[tide-checklist] polling health:', e.message || e)
    );
  }

  const workspaceDir = getWorkspaceDir();
  const storePath = getCronStorePath();
  const bootstrap = buildSessionBootstrapContext(workspaceDir, { logJid: getOwnerLogJid() }).block;
  const baseSystemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + (bootstrap || '');

  const results = [];
  const priorResults = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log('[tide-checklist] Item', i + 1 + '/' + items.length, '—', item.id);
    try {
      const result = await runOneItemViaAgent(item, {
        baseSystemPrompt,
        workspaceDir,
        storePath,
        priorResults,
      });
      results.push(result);
      priorResults.push(result);
      console.log('[tide-checklist]', result.ok ? 'OK' : 'FAIL', item.id, '—', (result.detail || '').slice(0, 120));
    } catch (e) {
      const fail = {
        id: item.id,
        label: item.label,
        ok: false,
        detail: e.message || String(e),
        durationMs: 0,
      };
      results.push(fail);
      priorResults.push(fail);
      console.error('[tide-checklist] FAIL', item.id, '—', fail.detail);
      if (isDailyLimitError(e)) {
        console.log('[tide-checklist] Daily LLM limit reached — stopping checklist early.');
        break;
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    trigger: ctx.trigger || (ctx.manual ? 'manual' : 'unknown'),
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };

  try {
    ensureStateDir();
    writeFileSync(getTideChecklistLastRunPath(), JSON.stringify(summary, null, 2), 'utf8');
  } catch (_) {}

  if (results.length) {
    console.log(
      '[tide-checklist]',
      summary.passed + '/' + summary.total,
      'passed',
      ctx.trigger ? `(trigger: ${ctx.trigger})` : ''
    );
  }

  return summary;
}

export function readLastChecklistRun() {
  const p = getTideChecklistLastRunPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function defaultTideChecklistBlock() {
  return {
    enabled: false,
    triggers: { ...DEFAULT_TRIGGERS },
    items: [
      {
        id: 'telegram-polling',
        label: 'Telegram polling health',
        prompt:
          'Confirm Telegram bot polling is healthy and the daemon can receive messages. Use tools if needed. Report OK or FAIL briefly.',
        enabled: true,
      },
    ],
  };
}
