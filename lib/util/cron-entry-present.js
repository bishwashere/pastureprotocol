/**
 * Structured labels for system crontab rows (name, purpose, technical details).
 */

import { humanizeCronExpr } from './cron-expr-humanize.js';
import { basenameAnyPath, isAbsoluteAnyPath } from './cross-platform-path.js';

const SCHEDULE_OR_META = [
  /^runs?\s+\d+\s+minutes?\s+before/i,
  /^every\s+\d+/i,
  /^\d+\s+times?\s+daily/i,
  /^cron script for/i,
  /^log file\b/i,
  /\(\s*replaced by/i,
  /\bevery\s+\d+\s+(minute|hour|day|week|month)s?\b/i,
  /\bcomplete automation\b/i,
  /\bdatabase-backed automation\b/i,
];

function humanizeScriptName(name) {
  const base = String(name || '').replace(/\.(sh|bash|py|pl|rb|js|mjs|cjs|ts|php|ps1|cmd|bat|command)$/i, '');
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Cron job';
}

function scriptBasenameFromCommand(command) {
  const scriptPath = scriptPathFromCommand(command);
  return scriptPath ? basenameAnyPath(scriptPath) : null;
}

function splitCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(command || ''))) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function scriptPathFromCommand(command) {
  const tokens = splitCommand(command);
  for (const t of tokens) {
    if (/\.(sh|bash|py|pl|rb|js|mjs|cjs|ts|php|ps1|cmd|bat|command)$/i.test(t) || isAbsoluteAnyPath(t) || t.startsWith('~/') || t.startsWith('~\\')) {
      return t;
    }
  }
  return null;
}

function isScheduleOrMeta(text) {
  const t = String(text || '').trim();
  if (!t) return true;
  return SCHEDULE_OR_META.some((re) => re.test(t));
}

function firstSentence(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const match = t.match(/^(.+?[.!?])(?:\s|$)/);
  const sentence = match ? match[1].trim() : t;
  return sentence.endsWith('.') || sentence.endsWith('!') || sentence.endsWith('?')
    ? sentence
    : `${sentence}.`;
}

/**
 * @param {string} [crontabNote]
 * @param {string|null} [scriptPath]
 * @param {string} [command]
 */
export function deriveCronName(crontabNote, scriptPath, command) {
  const note = String(crontabNote || '').trim();
  if (note) {
    const first = note.split(/\s+-\s+/)[0].trim();
    if (first) {
      return first
        .replace(/\s+Cron Jobs?$/i, '')
        .replace(/\s+\(Python\)$/i, '')
        .replace(/\s+Cron Pipeline$/i, ' Pipeline')
        .trim();
    }
  }
  const path = scriptPath || scriptBasenameFromCommand(command || '');
  if (path) return humanizeScriptName(basenameAnyPath(path));
  return 'Cron job';
}

/**
 * @param {string|null} scriptPurpose - meaningful script comment
 * @param {string} [crontabNote]
 */
export function derivePurpose(scriptPurpose, crontabNote) {
  const script = String(scriptPurpose || '').trim();
  if (script && !isScheduleOrMeta(script)) {
    const cleaned = script
      .replace(/^cron script for\s+/i, '')
      .replace(/^this script\s+/i, 'This script ')
      .trim();
    if (cleaned.length > 12) return firstSentence(cleaned);
  }

  const note = String(crontabNote || '').trim();
  if (note) {
    const segments = note.split(/\s+-\s+/);
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i].trim();
      if (!isScheduleOrMeta(seg) && seg.length > 8) return firstSentence(seg);
    }
  }

  if (script && !/^cron script for/i.test(script)) return firstSentence(script);
  return null;
}

function extractReplacementNote(text) {
  const m = String(text || '').match(/\(([^)]*replaced by[^)]*)\)/i);
  if (!m) return null;
  const body = m[1].trim();
  return body.charAt(0).toUpperCase() + body.slice(1);
}

function getCommandArgs(command, scriptPath) {
  const tokens = splitCommand(command);
  if (!tokens.length) return null;
  if (!scriptPath) return tokens.length > 1 ? tokens.slice(1).join(' ') : null;

  const base = basenameAnyPath(scriptPath);
  const idx = tokens.findIndex((t) => t === scriptPath || t.endsWith(scriptPath) || basenameAnyPath(t) === base);
  if (idx < 0) return null;
  const args = tokens.slice(idx + 1).join(' ').trim();
  return args || null;
}

/**
 * @param {object} entry
 * @param {{ ok?: boolean, error?: string }} info
 */
export function deriveTechnicalDetails(entry, info = {}) {
  /** @type {string[]} */
  const details = [];
  const replaced = extractReplacementNote(entry.crontabNote) || extractReplacementNote(entry.command);
  if (replaced) details.push(replaced);

  const args = getCommandArgs(entry.command, entry.scriptPath);
  if (args) details.push(`Args: ${args}`);

  if (info.error && !info.ok) details.push(info.error);

  const cmd = String(entry.command || '').trim();
  const path = entry.scriptPath || null;
  if (path && cmd !== path && cmd !== `sh ${path}` && cmd !== `bash ${path}`) {
    details.push(`Command: ${cmd}`);
  } else if (path && path !== basenameAnyPath(path)) {
    details.push(`Path: ${path}`);
  }

  return details;
}

/**
 * @param {object} entry
 * @param {{ ok?: boolean, error?: string, purpose?: string|null }} info
 */
export function presentCrontabEntry(entry, info = {}) {
  const scriptPath = entry.scriptPath || null;
  const name = deriveCronName(entry.crontabNote, scriptPath, entry.command);
  const scheduleHuman = humanizeCronExpr(entry.expr);
  const purpose = derivePurpose(info.purpose || null, entry.crontabNote);
  const scriptLabel = scriptPath
    ? basenameAnyPath(scriptPath)
    : scriptBasenameFromCommand(entry.command || '') || (entry.command || '').trim().split(/\s+/)[0] || '—';
  const technicalDetails = deriveTechnicalDetails({ ...entry, scriptPath }, info);

  return {
    name,
    scheduleHuman,
    purpose,
    scriptLabel,
    scriptPath,
    technicalDetails,
    description: purpose,
  };
}
