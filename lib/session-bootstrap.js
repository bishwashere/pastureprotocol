/**
 * Session / Tide bootstrap: load MEMORY.md and today + yesterday daily note markdown
 * (workspace/memory/YYYY-MM-DD.md). Injected into the system prompt — not part of chat session history.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getResolvedTimezone } from './timezone.js';

const MAX_SECTION_CHARS = 12_000;
const MAX_TOTAL_CHARS = 40_000;

/**
 * @param {Date} date
 * @param {string} tz
 */
export function getLocalDateString(date = new Date(), tz) {
  const resolvedTz = tz || getResolvedTimezone();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  return `${year}-${month}-${day}`;
}

/**
 * @param {Date} [date]
 * @param {string} [tz]
 * @returns {{ today: string, yesterday: string }}
 */
export function getTodayAndYesterdayDates(date = new Date(), tz) {
  const resolvedTz = tz || getResolvedTimezone();
  const today = getLocalDateString(date, resolvedTz);
  const yesterdayDate = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = getLocalDateString(yesterdayDate, resolvedTz);
  return { today, yesterday };
}

function readWorkspaceFile(workspaceDir, relPath) {
  const p = join(workspaceDir, relPath);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
}

function truncate(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…(truncated)';
}

/**
 * Read MEMORY.md + memory/<today>.md + memory/<yesterday>.md from disk.
 * @param {string} workspaceDir
 * @param {{ tz?: string, now?: Date, maxTotalChars?: number }} [opts]
 * @returns {{ block: string, sources: string[], totalChars: number }}
 */
export function buildSessionBootstrapContext(workspaceDir, opts = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') {
    return { block: '', sources: [], totalChars: 0 };
  }
  const { today, yesterday } = getTodayAndYesterdayDates(opts.now, opts.tz);
  const sections = [];
  const sources = [];

  const memoryMd = readWorkspaceFile(workspaceDir, 'MEMORY.md');
  if (memoryMd) {
    sections.push({ title: 'MEMORY.md', body: truncate(memoryMd, MAX_SECTION_CHARS) });
    sources.push('MEMORY.md');
  }

  for (const dateStr of [today, yesterday]) {
    const rel = `memory/${dateStr}.md`;
    const body = readWorkspaceFile(workspaceDir, rel);
    if (body) {
      sections.push({ title: rel, body: truncate(body, MAX_SECTION_CHARS) });
      sources.push(rel);
    }
  }

  if (sections.length === 0) {
    return { block: '', sources: [], totalChars: 0 };
  }

  const maxTotal = opts.maxTotalChars ?? MAX_TOTAL_CHARS;
  let header =
    '\n\n# Background notes and daily logs (bootstrap)\n' +
    'The following is from MEMORY.md and today/yesterday daily markdown logs on disk. ' +
    'It is **not** part of the current chat session transcript. Use it for continuity, open threads, and reminders.\n\n';

  let body = '';
  for (const sec of sections) {
    const chunk = `## ${sec.title}\n${sec.body}\n\n`;
    if (header.length + body.length + chunk.length > maxTotal) {
      body += chunk.slice(0, Math.max(0, maxTotal - header.length - body.length - 20)) + '\n…(truncated)\n\n';
      break;
    }
    body += chunk;
  }

  const block = header + body.trimEnd();
  console.log('[bootstrap] Loaded for context:', sources.join(', ') || '(none)');
  return { block, sources, totalChars: block.length };
}
