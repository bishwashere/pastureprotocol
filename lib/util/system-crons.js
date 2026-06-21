/**
 * System crons — read from the OS user crontab (`crontab -l`), not Pasture config.
 */

import { execSync } from 'child_process';
import { enrichCrontabEntries } from './cron-script-describe.js';

/**
 * Parse crontab -l text into dashboard rows.
 * @param {string} text
 * @returns {Array<{ id: string, expr: string, command: string, enabled: boolean, kind?: string }>}
 */
export function parseCrontabLines(text) {
  const lines = String(text || '').split('\n');
  /** @type {Array<{ id: string, expr: string, command: string, enabled: boolean, kind?: string, crontabNote?: string }>} */
  const entries = [];
  /** @type {string[]} */
  let pendingNotes = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) {
      pendingNotes = [];
      continue;
    }

    const note = pendingNotes.length ? pendingNotes.join(' ').trim() : undefined;

    if (trimmed.startsWith('#')) {
      const body = trimmed.slice(1).trim();
      const parsed = parseCronLine(body);
      if (parsed) {
        entries.push({
          id: `line-${i}`,
          expr: parsed.expr,
          command: parsed.command,
          enabled: false,
          crontabNote: note,
        });
        continue;
      }
      if (body) pendingNotes.push(body);
      entries.push({
        id: `comment-${i}`,
        kind: 'comment',
        expr: trimmed,
        command: '',
        enabled: false,
      });
      continue;
    }

    const parsed = parseCronLine(trimmed);
    if (parsed) {
      entries.push({
        id: `line-${i}`,
        expr: parsed.expr,
        command: parsed.command,
        enabled: true,
        crontabNote: note,
      });
    } else {
      entries.push({
        id: `line-${i}`,
        expr: trimmed,
        command: '',
        enabled: true,
        kind: 'raw',
        crontabNote: note,
      });
    }
  }

  return entries;
}

/**
 * @param {string} expr - first 5 cron fields
 */
function looksLikeCronExpr(expr) {
  const first = String(expr || '').split(/\s+/)[0] || '';
  return /^(@\w+|\*\/\d+|\*|\d[\d*,/-]*)$/i.test(first);
}

/**
 * @param {string} line - without leading #
 * @returns {{ expr: string, command: string }|null}
 */
function parseCronLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;

  const special = trimmed.match(/^(@[A-Za-z]+)\s+([\s\S]+)$/);
  if (special) {
    return { expr: special[1], command: special[2].trim() };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 6) {
    const expr = parts.slice(0, 5).join(' ');
    if (!looksLikeCronExpr(expr)) return null;
    return {
      expr,
      command: parts.slice(5).join(' '),
    };
  }
  return null;
}

/**
 * Read the current user's crontab.
 * @returns {{ ok: boolean, entries: ReturnType<typeof parseCrontabLines>, empty?: boolean, error?: string, user?: string }}
 */
export function readUserCrontab() {
  if (process.platform === 'win32') {
    return {
      ok: false,
      entries: [],
      error: 'crontab is not available on Windows (Pasture uses pm2 there).',
    };
  }

  try {
    const text = execSync('crontab -l', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const entries = parseCrontabLines(text).filter((e) => e.kind !== 'comment');
    return {
      ok: true,
      entries,
      empty: entries.length === 0,
      user: process.env.USER || process.env.LOGNAME || '',
    };
  } catch (err) {
    const stderr = err && err.stderr != null ? String(err.stderr) : '';
    const msg = stderr.trim() || (err && err.message ? String(err.message) : 'crontab -l failed');
    if (/no crontab for|can't open your crontab|no crontab installed/i.test(msg)) {
      return { ok: true, entries: [], empty: true, user: process.env.USER || process.env.LOGNAME || '' };
    }
    return { ok: false, entries: [], error: msg };
  }
}

const READ_SKILL_ID = 'read';

/**
 * Read crontab -l only when the read skill is enabled in Pasture config.
 * @param {object} [config]
 * @param {{ enabledSkills?: string[] }} [opts]
 */
export function readSystemCrontabForConfig(config = {}, opts = {}) {
  const enabledSkills = Array.isArray(opts.enabledSkills)
    ? opts.enabledSkills
    : (Array.isArray(config.skills?.enabled) ? config.skills.enabled : []);

  if (!enabledSkills.includes(READ_SKILL_ID)) {
    return {
      ok: false,
      entries: [],
      skillRequired: READ_SKILL_ID,
      error: 'Enable the read skill to view system crontab (crontab -l).',
    };
  }

  const result = readUserCrontab();
  if (result.ok && Array.isArray(result.entries) && result.entries.length > 0) {
    result.entries = enrichCrontabEntries(result.entries);
  }
  return result;
}

/** @deprecated use readSystemCrontabForConfig().entries */
export function listSystemCrons(config = {}, opts = {}) {
  return readSystemCrontabForConfig(config, opts).entries;
}
