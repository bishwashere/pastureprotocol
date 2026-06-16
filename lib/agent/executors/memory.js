/**
 * Memory executor: runs memory_search / memory_get / memory_save from LLM-provided args.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join, relative, dirname } from 'path';
import { getMemoryConfig } from '../memory-config.js';
import { getMemoryIndex } from '../memory-index.js';

const SNIPPET_MAX_CHARS = 700;

/** True if the query or args suggest the user is asking about "yesterday" (or a specific past date). */
function asksAboutYesterday(query, args) {
  const q = (query || '').toLowerCase();
  if (/yesterday|last night|the other day|previous (day|conversation|chat)/i.test(q)) return true;
  if (args?.date && String(args.date).toLowerCase() === 'yesterday') return true;
  return false;
}

/** YYYY-MM-DD for yesterday (server date). */
function yesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function padDate(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/**
 * Parse relative date range into { dateFrom, dateTo } (YYYY-MM-DD). Supports: yesterday, last_week, last_7_days, last_month.
 * @param {string} dateRange - e.g. "yesterday", "last_week", "last_7_days", "last_month"
 * @returns {{ dateFrom: string, dateTo: string } | null}
 */
function parseDateRange(dateRange) {
  const r = (dateRange || '').toLowerCase().trim();
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const day = today.getDate();
  if (/yesterday/.test(r)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    const s = padDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
    return { dateFrom: s, dateTo: s };
  }
  if (/last_?7_?days?|last_?week/.test(r)) {
    const end = new Date(today);
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return {
      dateFrom: padDate(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      dateTo: padDate(end.getFullYear(), end.getMonth() + 1, end.getDate()),
    };
  }
  if (/last_?month/.test(r)) {
    const end = new Date(today);
    end.setDate(0);
    const start = new Date(end.getFullYear(), end.getMonth(), 1);
    return {
      dateFrom: padDate(start.getFullYear(), start.getMonth() + 1, start.getDate()),
      dateTo: padDate(end.getFullYear(), end.getMonth() + 1, end.getDate()),
    };
  }
  return null;
}

/**
 * Read chat-log/YYYY-MM-DD.jsonl and return one result per exchange (path, startLine, endLine, snippet, score).
 * Used when the user asks about "yesterday" so we don't rely on semantic match for that word.
 */
function resultsFromChatLogFile(workspaceDir, dateStr) {
  const relPath = `chat-log/${dateStr}.jsonl`;
  const fullPath = join(workspaceDir, relPath);
  if (!existsSync(fullPath)) return [];
  let content = '';
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch (_) {
    return [];
  }
  const lines = content.split('\n').filter((l) => l.trim());
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]);
      const user = (row.user != null ? String(row.user) : '').trim();
      const assistant = (row.assistant != null ? String(row.assistant) : '').trim();
      const text = `User: ${user}\nAssistant: ${assistant}`.trim();
      if (!text) continue;
      const snippet = text.length > SNIPPET_MAX_CHARS ? text.slice(0, SNIPPET_MAX_CHARS) + '…' : text;
      results.push({
        path: relPath,
        startLine: i + 1,
        endLine: i + 1,
        snippet,
        score: 0.5,
      });
    } catch (_) {}
  }
  return results;
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - LLM tool args
 * @param {string} toolName - memory_search | memory_get
 */
export async function executeMemory(ctx, args, toolName = 'memory_search') {
  const config = getMemoryConfig();
  if (!config) {
    return JSON.stringify({ error: 'Memory is not configured. Add "memory" to skills.enabled and set an embedding API key (e.g. OpenAI).' });
  }
  const index = getMemoryIndex(config);
  if (!index) return JSON.stringify({ error: 'Memory index unavailable.' });
  const workspaceDir = ctx.workspaceDir || config.workspaceDir;
  if (!workspaceDir) return JSON.stringify({ error: 'Workspace path not set.' });

  if (toolName === 'memory_search') {
    const query = (args?.query && String(args.query).trim()) || '';
    if (!query) return JSON.stringify({ error: 'query is required.', results: [] });
    let dateFrom = (args?.dateFrom && String(args.dateFrom).trim()) || null;
    let dateTo = (args?.dateTo && String(args.dateTo).trim()) || null;
    const dateRange = (args?.dateRange && String(args.dateRange).trim()) || null;
    const typeFilter = (args?.type && String(args.type).trim()) || null;
    if (dateRange && (!dateFrom || !dateTo)) {
      const parsed = parseDateRange(dateRange);
      if (parsed) {
        dateFrom = dateFrom || parsed.dateFrom;
        dateTo = dateTo || parsed.dateTo;
      }
    }
    try {
      const searchOpts = (dateFrom || dateTo || typeFilter) ? { dateFrom, dateTo, type: typeFilter } : {};
      let results = await index.search(query, searchOpts);
      const maxResults = Math.min(20, Math.max(1, Number(args?.maxResults) || config.search.maxResults));
      const minScore = Number(args?.minScore) ?? config.search.minScore;
      let filtered = results.filter((r) => r.score >= minScore).slice(0, maxResults);
      const wantsFilesOrDirs = /directory|list of files|files and folders|what files|file listing|workspace contents/i.test(query);
      const hasFilesystemResults = filtered.some((r) => r.path && r.path.startsWith('filesystem/'));
      if (wantsFilesOrDirs && !hasFilesystemResults) {
        const fallbackResults = await index.search('Directory Contents list of files and folders', { ...searchOpts, maxResults: 30 });
        const fallbackFs = fallbackResults.filter((r) => r.path && r.path.startsWith('filesystem/') && r.score >= minScore).slice(0, maxResults);
        if (fallbackFs.length > 0) {
          filtered = fallbackFs;
        } else if (index.listFilesystem) {
          const listFs = index.listFilesystem(20);
          if (listFs.length > 0) filtered = listFs.slice(0, maxResults);
        }
      }

      // When the user asks about "yesterday", semantic search often returns no chat-log hits
      // because the word "yesterday" doesn't appear in the conversation. Add yesterday's
      // chat-log file as results so the agent can answer.
      if (asksAboutYesterday(query, args)) {
        const yesterdayResults = resultsFromChatLogFile(workspaceDir, yesterdayDateStr());
        if (yesterdayResults.length > 0) {
          const fromSemantic = filtered.filter((r) => r.path.startsWith('chat-log/'));
          const hasChatLogFromSemantic = fromSemantic.length > 0;
          if (!hasChatLogFromSemantic || fromSemantic.every((r) => !r.path.includes(yesterdayDateStr()))) {
            filtered = [...yesterdayResults.slice(0, maxResults), ...filtered]
              .slice(0, maxResults);
          }
        }
      }

      return JSON.stringify({
        results: filtered.map((r) => ({
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          snippet: r.snippet,
          score: Math.round(r.score * 100) / 100,
          type: r.type ?? null,
        })),
      });
    } catch (err) {
      console.error('[memory] search failed:', err.message);
      return JSON.stringify({ error: err.message, results: [] });
    }
  }

  if (toolName === 'memory_get') {
    const path = (args?.path && String(args.path).trim()) || '';
    if (!path) return JSON.stringify({ error: 'path is required.', text: '' });
    const from = args?.from != null ? Number(args.from) : undefined;
    const lines = args?.lines != null ? Number(args.lines) : undefined;
    try {
      const out = index.readFile(path, from, lines);
      return JSON.stringify({ path: out.path, text: out.text });
    } catch (err) {
      console.error('[memory] readFile failed:', err.message);
      return JSON.stringify({ error: err.message, path, text: '' });
    }
  }

  if (toolName === 'memory_save') {
    const text = (args?.text && String(args.text).trim()) || '';
    if (!text) return JSON.stringify({ error: 'text is required for memory_save.' });
    const saveType = (args?.type && String(args.type).trim()) || null;

    // Resolve target file — default MEMORY.md, or a caller-specified .md path.
    let targetRelPath = (args?.file && String(args.file).trim()) || 'MEMORY.md';
    targetRelPath = targetRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!targetRelPath.endsWith('.md')) {
      return JSON.stringify({ error: 'file must be a .md path (e.g. MEMORY.md or memory/notes.md).' });
    }
    const resolved = join(workspaceDir, targetRelPath);
    const rel = relative(workspaceDir, resolved);
    if (rel.startsWith('..') || rel.includes('..')) {
      return JSON.stringify({ error: 'file must be within the workspace directory.' });
    }

    try {
      const dir = dirname(resolved);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const now = new Date();
      const dateStr = now.getFullYear() + '-'
        + String(now.getMonth() + 1).padStart(2, '0') + '-'
        + String(now.getDate()).padStart(2, '0');
      const line = saveType
        ? `- ${dateStr} [${saveType}]: ${text}\n`
        : `- ${dateStr}: ${text}\n`;
      appendFileSync(resolved, line, 'utf8');

      // Re-sync so the saved note is immediately searchable.
      try { await index.sync(); } catch (_) {}

      return JSON.stringify({ saved: true, file: targetRelPath, text, type: saveType });
    } catch (err) {
      console.error('[memory] memory_save failed:', err.message);
      return JSON.stringify({ error: err.message });
    }
  }

  return JSON.stringify({ error: `Unknown memory tool: ${toolName}` });
}
