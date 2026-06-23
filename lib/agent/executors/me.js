/**
 * Me skill: build a profile of what we know about the user from MEMORY.md, memory/*.md, recent chat logs, and active reminders only.
 * Presents it in a human-friendly format.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getCronStorePath } from '../../util/paths.js';
import { loadJobs } from '../../../cron/store.js';
import { formatProjectsProfileLine } from '../../context/projects-context.js';
import { logJidToFileBase } from '../../context/chat-log.js';

const CHAT_LOG_DIR = 'chat-log';
const PRIVATE_CHAT_DIR = 'private';
const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_DAYS_CHAT = 7;
const MAX_EXCHANGES_SUMMARY = 30;

function getChatLogDir(workspaceDir) {
  return join(workspaceDir, CHAT_LOG_DIR);
}

function readFile(workspaceDir, relPath) {
  const p = join(workspaceDir, relPath);
  if (!existsSync(p)) return '';
  try {
    return readFileSync(p, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function readNotes(workspaceDir) {
  const out = { memoryMd: '', memoryFiles: [] };
  out.memoryMd = readFile(workspaceDir, 'MEMORY.md');
  const memoryDir = join(workspaceDir, 'memory');
  if (existsSync(memoryDir)) {
    try {
      const names = readdirSync(memoryDir, { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith('.md'))
        .map((f) => f.name)
        .sort();
      for (const name of names) {
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        const content = readFile(workspaceDir, join('memory', name));
        if (content) out.memoryFiles.push({ name: `memory/${name}`, content });
      }
    } catch (_) {}
  }
  return out;
}

function readDateBasedChatLogs(workspaceDir, maxDays = MAX_DAYS_CHAT) {
  const dir = getChatLogDir(workspaceDir);
  if (!existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && DATE_FILE_RE.test(f.name))
      .map((f) => f.name)
      .sort()
      .reverse()
      .slice(0, maxDays);
  } catch (_) {
    return [];
  }
  const all = [];
  for (const name of files) {
    const path = join(dir, name);
    try {
      const content = readFileSync(path, 'utf8');
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t);
          if (row != null && (row.user != null || row.assistant != null)) {
            all.push({
              date: name.replace('.jsonl', ''),
              ts: row.ts || 0,
              user: String(row.user ?? '').trim(),
              assistant: String(row.assistant ?? '').trim(),
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return all;
}

function readPrivateChatLog(workspaceDir, jid) {
  if (!jid || String(jid).trim() === '') return [];
  const file = join(getChatLogDir(workspaceDir), PRIVATE_CHAT_DIR, logJidToFileBase(jid) + '.jsonl');
  if (!existsSync(file)) return [];
  const out = [];
  try {
    const content = readFileSync(file, 'utf8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t);
        if (row != null && (row.user != null || row.assistant != null)) {
          out.push({
            ts: row.ts || 0,
            user: String(row.user ?? '').trim(),
            assistant: String(row.assistant ?? '').trim(),
          });
        }
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

/** Dated line in MEMORY.md: "- 2026-02-23: something" or "2026-02-23: something" */
const DATED_LINE_RE = /^\s*[-*]?\s*(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/;

/** Active reminders only: enabled cron jobs and one-shots not yet sent. */
function getActiveReminders(storePath) {
  try {
    const jobs = loadJobs(storePath);
    const now = Date.now();
    return jobs
      .filter((j) => j.enabled !== false)
      .filter((j) => {
        if (j.schedule?.kind === 'at' && j.schedule?.at) {
          const atMs = new Date(j.schedule.at).getTime();
          if (j.sentAtMs || atMs <= now) return false;
        }
        return true;
      })
      .map((j) => (j.name && j.name.trim()) || (j.message && j.message.trim().slice(0, 60)) || 'Reminder')
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function extractBasic(workspaceDir) {
  const bullets = [];
  const whoAmI = readFile(workspaceDir, 'WhoAmI.md');
  const myHuman = readFile(workspaceDir, 'MyHuman.md');
  if (whoAmI) {
    const line = whoAmI.split(/\n/)[0]?.trim();
    if (line && line.length < 200) bullets.push(line);
    else if (whoAmI.length < 500) bullets.push(whoAmI);
  }
  if (myHuman) {
    const lines = myHuman.split(/\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    bullets.push(...lines.filter((l) => l.length < 200));
  }
  return bullets;
}

function extractThingsToRemember(memoryMd) {
  if (!memoryMd) return [];
  const bullets = [];
  for (const line of memoryMd.split(/\n/)) {
    const m = line.match(DATED_LINE_RE);
    if (m) bullets.push(`On ${m[1]}: ${m[2].trim()}`);
  }
  return bullets;
}

function extractRecentContext(dateBasedExchanges, privateExchanges) {
  const all = [...privateExchanges];
  for (const ex of dateBasedExchanges) all.push(ex);
  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const recent = all.slice(-MAX_EXCHANGES_SUMMARY);
  const bullets = [];
  const seen = new Set();
  for (const ex of recent) {
    const u = (ex.user || '').trim().slice(0, 100);
    if (u && u.length > 5 && !seen.has(u)) {
      seen.add(u);
      bullets.push(u + (u.length >= 100 ? '…' : ''));
    }
  }
  return bullets.slice(-15);
}

function formatProfile(workspaceDir, notes, dateBasedExchanges, privateExchanges, activeReminders) {
  const basic = extractBasic(workspaceDir);
  const thingsToRemember = extractThingsToRemember(notes.memoryMd);
  const recentContext = extractRecentContext(dateBasedExchanges, privateExchanges);

  const parts = [];

  if (basic.length > 0) {
    parts.push(basic.join(' '));
  }
  // Include MEMORY.md body so name, preferences, etc. are in the profile (not just dated lines).
  if (notes.memoryMd && notes.memoryMd.trim()) {
    const trimmed = notes.memoryMd.trim();
    const maxLen = 1500;
    parts.push(trimmed.length <= maxLen ? trimmed : trimmed.slice(0, maxLen) + '…');
  }
  if (notes.memoryFiles.length > 0) {
    const summaries = notes.memoryFiles.slice(0, 5).map((f) => (f.content && f.content.trim().slice(0, 200)) || f.name).filter(Boolean);
    if (summaries.length) parts.push(summaries.join(' '));
  }
  if (thingsToRemember.length > 0) {
    parts.push("You've told me to remember " + thingsToRemember.join(', and ') + ".");
  }
  if (activeReminders.length > 0) {
    const r = activeReminders.slice(0, 10);
    parts.push("You've got active reminders like " + r.join(', ') + (activeReminders.length > 10 ? " and a few more" : "") + ".");
  }
  if (recentContext.length > 0) {
    parts.push("Lately we've been talking about " + recentContext.slice(0, 5).join(', ') + ".");
  }
  const projectsLine = formatProjectsProfileLine();
  if (projectsLine) parts.push(projectsLine);

  if (parts.length === 0) {
    return "I don't have any notes or recent chats to go on yet. You can tell me about yourself or add things to MEMORY.md and WhoAmI.md, and I'll keep them in mind.";
  }

  return parts.join(' ');
}

/**
 * @param {object} ctx - { workspaceDir, jid }
 * @param {object} args - No required args
 */
export async function executeMe(ctx, args) {
  const workspaceDir = ctx?.workspaceDir || '';
  if (!workspaceDir) {
    return JSON.stringify({ error: 'Workspace path not available.' });
  }

  const jid = ctx?.jid;

  const notes = readNotes(workspaceDir);
  const dateBasedExchanges = readDateBasedChatLogs(workspaceDir);
  const privateExchanges = readPrivateChatLog(workspaceDir, jid);
  const activeReminders = getActiveReminders(getCronStorePath());

  const profile = formatProfile(workspaceDir, notes, dateBasedExchanges, privateExchanges, activeReminders);
  return profile;
}
