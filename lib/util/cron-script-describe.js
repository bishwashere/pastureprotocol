/**
 * Read cron command scripts and derive a short description (read skill gate is upstream).
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { extname, basename } from 'path';
import { presentCrontabEntry } from './cron-entry-present.js';

const MAX_READ_BYTES = 48_000;
const MAX_DESC_LEN = 320;

const WRAPPER_TOKENS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish',
  '/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/env', 'env',
]);

const SCRIPT_EXT = /\.(sh|bash|py|pl|rb|js|mjs|cjs|ts|php|command)$/i;

const SHEBANG_OR_INTERPRETER = /^(\/usr\/bin\/env|\/bin\/|\/usr\/bin\/)/i;

/**
 * @param {string} command
 * @returns {string|null}
 */
export function extractScriptPath(command) {
  const raw = String(command || '').trim();
  if (!raw) return null;

  const tokens = raw.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (!t || t.startsWith('-')) continue;

    if (t === 'env') {
      i += 1;
      while (i < tokens.length && tokens[i].startsWith('-')) i += 1;
      if (i < tokens.length && !WRAPPER_TOKENS.has(tokens[i])) i += 1;
      continue;
    }

    if (WRAPPER_TOKENS.has(t)) continue;

    if (t.startsWith('~/')) t = t.replace(/^~/, homedir());
    else if (t === '~') continue;

    if (t.startsWith('/') || t.startsWith('./') || t.startsWith('../') || SCRIPT_EXT.test(t)) {
      return t;
    }
    break;
  }
  return null;
}

function isUsefulComment(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (SHEBANG_OR_INTERPRETER.test(t)) return false;
  if (/^(bash|sh|zsh|python3?|node)$/i.test(t)) return false;
  return true;
}

/** Reject shebang fragments and bare interpreter paths that are not real summaries. */
function isUselessDescription(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (/^(\/usr\/bin\/env\s+\S+|\/bin\/(bash|sh|zsh|dash)|\/usr\/bin\/(bash|sh|zsh|python3?|node))$/i.test(t)) return true;
  if (/^(bash|sh|zsh|dash|python3?|node)$/i.test(t)) return true;
  return false;
}

function firstUniqueSentence(text, exclude = '') {
  const excludeNorm = String(exclude || '').toLowerCase();
  const parts = String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const part of parts) {
    const key = part.slice(0, 28).toLowerCase();
    if (key && !excludeNorm.includes(key)) return part;
  }
  return '';
}

/**
 * @param {string} content
 * @param {string} [filePath]
 */
export function describeScriptContent(content, filePath = '') {
  const ext = extname(filePath || '').toLowerCase();
  const lines = String(content || '').split(/\r?\n/);
  const comments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (comments.length) break;
      continue;
    }

    if (ext === '.py') {
      if (trimmed.startsWith('#')) {
        const body = trimmed.replace(/^#\s*/, '').trim();
        if (isUsefulComment(body)) comments.push(body);
        continue;
      }
      const doc = trimmed.match(/^("""|''')([\s\S]*?)("""|''')$/);
      if (doc) {
        comments.push(doc[2].trim());
        break;
      }
      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        comments.push(trimmed.replace(/^["']{3}|["']{3}$/g, '').trim());
        continue;
      }
      break;
    }

    if (trimmed.startsWith('#!')) continue;

    if (trimmed.startsWith('#')) {
      const body = trimmed.slice(1).trim();
      if (isUsefulComment(body)) comments.push(body);
      continue;
    }
    if (trimmed.startsWith(': ') || trimmed === ':') {
      const body = trimmed.replace(/^:\s*/, '').trim();
      if (isUsefulComment(body)) comments.push(body);
      continue;
    }
    break;
  }

  let text = comments
    .slice(0, 3)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (isUselessDescription(text)) text = '';

  if (!text) {
    const firstCode = lines.find((l) => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith(':');
    });
    if (firstCode) {
      text = `Runs: ${firstCode.trim().slice(0, 120)}`;
    }
  }

  if (!text && filePath) {
    text = humanizeScriptName(basename(filePath));
  }

  if (text.length > MAX_DESC_LEN) text = `${text.slice(0, MAX_DESC_LEN - 1)}…`;
  return text || null;
}

/**
 * First actionable comment line from a script (for purpose, not full header dump).
 * @param {string} content
 * @param {string} [filePath]
 * @returns {string|null}
 */
export function extractPurposeFromScript(content, filePath = '') {
  const ext = extname(filePath || '').toLowerCase();
  const lines = String(content || '').split(/\r?\n/);
  /** @type {string[]} */
  const comments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (comments.length) break;
      continue;
    }
    if (trimmed.startsWith('#!')) continue;

    if (ext === '.py') {
      if (trimmed.startsWith('#')) {
        const body = trimmed.replace(/^#\s*/, '').trim();
        if (isUsefulComment(body)) comments.push(body);
        continue;
      }
      break;
    }

    if (trimmed.startsWith('#')) {
      const body = trimmed.slice(1).trim();
      if (isUsefulComment(body)) comments.push(body);
      continue;
    }
    if (trimmed.startsWith(': ') || trimmed === ':') {
      const body = trimmed.replace(/^:\s*/, '').trim();
      if (isUsefulComment(body)) comments.push(body);
      continue;
    }
    break;
  }

  const META = [
    /^cron script for/i,
    /^runs?\s+\d+\s+minutes?\s+before/i,
    /^log file\b/i,
  ];
  for (const c of comments) {
    if (!META.some((re) => re.test(c))) return c;
  }
  return comments[1] || comments[0] || null;
}

function humanizeScriptName(name) {
  const base = String(name || '').replace(/\.(sh|bash|py|command)$/i, '');
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Cron job';
}

/**
 * @param {string} command
 * @param {string|null} scriptPath
 */
export function inferCommandSummary(command, scriptPath = null) {
  const path = scriptPath || extractScriptPath(command);
  const tokens = String(command || '').trim().split(/\s+/);
  let args = tokens;
  if (path) {
    const idx = tokens.findIndex((t) => t === path || t.endsWith(path));
    if (idx >= 0) args = tokens.slice(idx + 1);
  }
  const argText = args.filter((a) => a && !a.startsWith('(')).join(' ').trim();
  const name = path ? basename(path) : '';
  const parts = [];
  if (name) parts.push(humanizeScriptName(name));
  if (argText) parts.push(`args: ${argText}`);
  return parts.join(' — ') || null;
}

function mergeDescriptions(scriptDesc, crontabNote, command, scriptPath) {
  const note = String(crontabNote || '').trim();
  let script = String(scriptDesc || '').trim();
  if (isUselessDescription(script)) script = '';
  const inferred = inferCommandSummary(command, scriptPath);

  if (note && script) {
    const noteNorm = note.toLowerCase();
    const scriptNorm = script.toLowerCase();
    if (scriptNorm.includes(noteNorm)) return script;
    const extra = firstUniqueSentence(script, note);
    if (extra) {
      const joined = note.endsWith('.') ? `${note} ${extra}` : `${note}. ${extra}`;
      return joined.length > MAX_DESC_LEN ? `${joined.slice(0, MAX_DESC_LEN - 1)}…` : joined;
    }
    return note;
  }
  if (script) return script;
  if (note) return note;
  if (inferred && !isUselessDescription(inferred)) return inferred;
  return null;
}

/**
 * @param {string} filePath
 * @returns {{ ok: boolean, description?: string, scriptPath?: string, error?: string }}
 */
export function describeScriptFile(filePath) {
  const resolved = String(filePath || '').trim();
  if (!resolved) {
    return { ok: false, error: 'No script path in command.' };
  }

  if (!existsSync(resolved)) {
    return { ok: false, scriptPath: resolved, error: 'Script not found on disk (path may be stale).' };
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, scriptPath: resolved, error: 'Path is not a file.' };
    }
    let content;
    if (stat.size > MAX_READ_BYTES) {
      const fd = openSync(resolved, 'r');
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const n = readSync(fd, buf, 0, MAX_READ_BYTES, 0);
      closeSync(fd);
      content = buf.slice(0, n).toString('utf8');
    } else {
      content = readFileSync(resolved, 'utf8');
    }
    const description = describeScriptContent(content, resolved);
    const purpose = extractPurposeFromScript(content, resolved);
    return {
      ok: true,
      scriptPath: resolved,
      description: description || humanizeScriptName(basename(resolved)),
      purpose: purpose || description || humanizeScriptName(basename(resolved)),
    };
  } catch (err) {
    return {
      ok: false,
      scriptPath: resolved,
      error: err && err.code === 'EACCES' ? 'Permission denied reading script.' : (err.message || 'Could not read script.'),
    };
  }
}

/**
 * @param {string} command
 */
export function describeCronCommand(command) {
  const scriptPath = extractScriptPath(command);
  if (!scriptPath) {
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'Empty command.' };
    return {
      ok: true,
      description: cmd.length > MAX_DESC_LEN ? `${cmd.slice(0, MAX_DESC_LEN - 1)}…` : cmd,
    };
  }
  return describeScriptFile(scriptPath);
}

/**
 * @param {Array<{ command: string, crontabNote?: string, [key: string]: unknown }>} entries
 */
export function enrichCrontabEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const command = entry.command || '';
    const info = describeCronCommand(command);
    const scriptPath = info.scriptPath || extractScriptPath(command) || null;
    const presented = presentCrontabEntry(
      { ...entry, scriptPath },
      { ok: info.ok, error: info.error, purpose: info.purpose || null },
    );

    return {
      ...entry,
      ...presented,
      description: presented.purpose,
      descriptionError: presented.purpose ? null : (info.error || null),
    };
  });
}
