/**
 * Tide maintenance checklist: configurable items run on restart, health-check cycle, or follow-up.
 * Stored in config.json under tide.checklist; last run written to tide-checklist-last.json.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getConfigPath, getStateDir, ensureStateDir } from './paths.js';
import { isInTideInactiveWindow } from './timezone.js';
import { ensurePollingAlive } from './telegram.js';

const DEFAULT_TRIGGERS = {
  onRestart: true,
  onCycle: true,
  onFollowUp: false,
};

const DEFAULT_CHECKLIST = {
  enabled: false,
  triggers: { ...DEFAULT_TRIGGERS },
  items: [],
};

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

/** @returns {import('./tide-checklist.js').TideChecklistConfig} */
export function normalizeChecklistConfig(tide = {}) {
  const raw = tide.checklist && typeof tide.checklist === 'object' ? tide.checklist : {};
  const triggers = { ...DEFAULT_TRIGGERS, ...(raw.triggers && typeof raw.triggers === 'object' ? raw.triggers : {}) };
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({
          id: String(it.id || '').trim() || slugFromLabel(it.label),
          label: String(it.label || it.id || 'Check').trim(),
          enabled: it.enabled !== false,
          type: normalizeItemType(it.type),
          command: it.command != null ? String(it.command).trim() : undefined,
          url: it.url != null ? String(it.url).trim() : undefined,
          path: it.path != null ? String(it.path).trim() : undefined,
          expectStatus: it.expectStatus != null ? Number(it.expectStatus) : 200,
          timeoutMs: Math.min(120_000, Math.max(1000, Number(it.timeoutMs) || 30_000)),
          builtin: it.builtin != null ? String(it.builtin).trim() : undefined,
        }))
    : [];
  return {
    enabled: !!raw.enabled,
    triggers,
    items,
  };
}

function normalizeItemType(type) {
  const t = String(type || 'shell').toLowerCase();
  if (t === 'http' || t === 'file' || t === 'file_exists' || t === 'builtin') return t === 'file' ? 'file_exists' : t;
  return 'shell';
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
 * @param {{ label: string, type?: string, command?: string, url?: string, path?: string, builtin?: string, enabled?: boolean }} opts
 */
export function addChecklistItem(opts) {
  const label = String(opts.label || '').trim();
  if (!label) return { ok: false, message: 'Label is required.' };

  const config = loadConfig();
  getTideBlock(config);
  const items = config.tide.checklist.items;
  const existingIds = new Set(items.map((i) => i.id));
  const id = uniqueId(slugFromLabel(label), existingIds);
  const type = normalizeItemType(opts.type);
  const item = { id, label, enabled: opts.enabled !== false, type, timeoutMs: 30_000 };

  if (type === 'shell') {
    const command = String(opts.command || '').trim();
    if (!command) return { ok: false, message: 'Shell items require --command.' };
    item.command = command;
  } else if (type === 'http') {
    const url = String(opts.url || '').trim();
    if (!url) return { ok: false, message: 'HTTP items require --url.' };
    item.url = url;
    item.expectStatus = opts.expectStatus != null ? Number(opts.expectStatus) : 200;
  } else if (type === 'file_exists') {
    const path = String(opts.path || '').trim();
    if (!path) return { ok: false, message: 'File items require --path.' };
    item.path = path;
  } else if (type === 'builtin') {
    const builtin = String(opts.builtin || '').trim();
    if (!builtin) return { ok: false, message: 'Builtin items require --builtin (e.g. telegram_polling).' };
    item.builtin = builtin;
  }

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

/**
 * @param {{ onRestart?: boolean, onCycle?: boolean, onFollowUp?: boolean }} patch
 */
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

/**
 * Whether automatic checklist should run for this trigger (respects tide + checklist + quiet hours).
 * @param {'onRestart'|'onCycle'|'onFollowUp'} trigger
 * @param {{ tide?: object, skipInactiveWindow?: boolean }} [opts]
 */
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

function runShell(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, detail: `Timed out after ${timeoutMs}ms`, stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500) });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        detail: code === 0 ? 'Exit 0' : `Exit ${code}`,
        stdout: stdout.trim().slice(0, 500),
        stderr: stderr.trim().slice(0, 500),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message || String(err) });
    });
  });
}

async function runHttp(url, expectStatus, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    const ok = res.status === expectStatus;
    return {
      ok,
      detail: ok ? `HTTP ${res.status}` : `HTTP ${res.status} (expected ${expectStatus})`,
    };
  } catch (e) {
    const msg = e.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : (e.message || String(e));
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function runBuiltin(name, ctx) {
  if (name === 'telegram_polling') {
    if (!ctx.telegramBot) {
      return { ok: false, detail: 'Telegram bot not available' };
    }
    try {
      await ensurePollingAlive(ctx.telegramBot);
      return { ok: true, detail: 'Polling health check completed' };
    } catch (e) {
      return { ok: false, detail: e.message || String(e) };
    }
  }
  return { ok: false, detail: `Unknown builtin: ${name}` };
}

async function runOneItem(item, ctx) {
  const started = Date.now();
  let result;
  if (item.type === 'shell') {
    result = await runShell(item.command, item.timeoutMs);
  } else if (item.type === 'http') {
    result = await runHttp(item.url, item.expectStatus ?? 200, item.timeoutMs);
  } else if (item.type === 'file_exists') {
    const ok = existsSync(item.path);
    result = { ok, detail: ok ? 'File exists' : 'File not found' };
  } else if (item.type === 'builtin') {
    result = await runBuiltin(item.builtin, ctx);
  } else {
    result = { ok: false, detail: `Unsupported type: ${item.type}` };
  }
  return {
    id: item.id,
    label: item.label,
    ok: result.ok,
    detail: result.detail,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
  };
}

/**
 * Run all enabled checklist items.
 * @param {{ telegramBot?: object, onlyIds?: string[], manual?: boolean }} [ctx]
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

  const results = [];
  for (const item of items) {
    try {
      results.push(await runOneItem(item, ctx));
    } catch (e) {
      results.push({
        id: item.id,
        label: item.label,
        ok: false,
        detail: e.message || String(e),
        durationMs: 0,
      });
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

  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log('[tide-checklist] FAIL', r.id, '—', r.detail);
  }
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
        enabled: true,
        type: 'builtin',
        builtin: 'telegram_polling',
        timeoutMs: 30_000,
      },
    ],
  };
}
