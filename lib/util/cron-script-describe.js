/**
 * Read cron command scripts and derive a short description (read skill gate is upstream).
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { homedir } from 'os';
import { extname, basename } from 'path';

const MAX_READ_BYTES = 48_000;
const MAX_DESC_LEN = 320;

const WRAPPER_TOKENS = new Set([
  'sh', 'bash', 'zsh', 'ksh', 'dash', 'fish',
  '/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/env', 'env',
]);

const SCRIPT_EXT = /\.(sh|bash|py|pl|rb|js|mjs|cjs|ts|php|command)$/i;

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
        comments.push(trimmed.replace(/^#\s*/, ''));
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

    if (trimmed.startsWith('#')) {
      comments.push(trimmed.replace(/^#!?/, '').trim());
      continue;
    }
    if (trimmed.startsWith(': ') || trimmed === ':') {
      comments.push(trimmed.replace(/^:\s*/, '').trim());
      continue;
    }
    break;
  }

  let text = comments
    .map((c) => c.replace(/^!\/.*/, '').trim())
    .filter((c) => c && !/^\/usr\/bin\/env/i.test(c))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

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
    text = `Runs ${basename(filePath)}`;
  }

  if (text.length > MAX_DESC_LEN) text = `${text.slice(0, MAX_DESC_LEN - 1)}…`;
  return text || null;
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
    return { ok: false, scriptPath: resolved, error: 'Script not found.' };
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, scriptPath: resolved, error: 'Path is not a file.' };
    }
    if (stat.size > MAX_READ_BYTES) {
      const fd = openSync(resolved, 'r');
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const n = readSync(fd, buf, 0, MAX_READ_BYTES, 0);
      closeSync(fd);
      const partial = buf.slice(0, n).toString('utf8');
      const description = describeScriptContent(partial, resolved);
      return {
        ok: true,
        scriptPath: resolved,
        description: description || `Runs ${basename(resolved)} (large file; read first ${MAX_READ_BYTES} bytes).`,
      };
    }
    const content = readFileSync(resolved, 'utf8');
    const description = describeScriptContent(content, resolved);
    return {
      ok: true,
      scriptPath: resolved,
      description: description || `Runs ${basename(resolved)}.`,
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
 * @param {Array<{ command: string, [key: string]: unknown }>} entries
 */
export function enrichCrontabEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const command = entry.command || '';
    const info = describeCronCommand(command);
    return {
      ...entry,
      scriptPath: info.scriptPath || extractScriptPath(command) || null,
      description: info.description || info.error || null,
      descriptionError: info.ok ? null : (info.error || null),
    };
  });
}
