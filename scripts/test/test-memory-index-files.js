/**
 * Memory index file lists: daily history from chat-log, not date-stamped memory/*.md
 */

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listMemoryFiles, listChatLogFiles } from '../../lib/memory-index.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-memidx-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true });
  mkdirSync(join(workspaceDir, 'chat-log', 'private'), { recursive: true });

  writeFileSync(join(workspaceDir, 'MEMORY.md'), '# Notes\nLong-term.', 'utf8');
  writeFileSync(join(workspaceDir, 'memory', '2026-05-17.md'), 'Added reminder: test', 'utf8');
  writeFileSync(join(workspaceDir, 'memory', 'preferences.md'), '# Prefs\nDark mode.', 'utf8');

  const chatDaily = join(workspaceDir, 'chat-log', '2026-05-28.jsonl');
  writeFileSync(chatDaily, JSON.stringify({ ts: Date.now(), user: 'hi', assistant: 'hello' }) + '\n', 'utf8');
  const chatPrivate = join(workspaceDir, 'chat-log', 'private', 'owner.jsonl');
  writeFileSync(chatPrivate, JSON.stringify({ ts: Date.now(), user: 'hey', assistant: 'yo' }) + '\n', 'utf8');

  const now = Date.now() / 1000;
  utimesSync(chatDaily, now, now);
  utimesSync(chatPrivate, now, now);

  return workspaceDir;
}

function main() {
  const workspaceDir = setup();
  const memoryFiles = listMemoryFiles(workspaceDir).map((f) => f.relPath).sort();
  const chatFiles = listChatLogFiles(workspaceDir).map((f) => f.relPath).sort();

  if (!memoryFiles.includes('MEMORY.md')) throw new Error('expected MEMORY.md in index list');
  if (memoryFiles.includes('memory/2026-05-17.md')) throw new Error('date-stamped memory/*.md must not be indexed');
  if (!memoryFiles.includes('memory/preferences.md')) throw new Error('expected custom memory/*.md notes to remain indexable');
  if (!chatFiles.includes('chat-log/2026-05-28.jsonl')) throw new Error('expected dated chat-log in index list');
  if (!chatFiles.includes('chat-log/private/owner.jsonl')) throw new Error('expected private chat-log in index list');

  console.log('Memory index file list test passed.');
  console.log('  notes:', memoryFiles.join(', '));
  console.log('  chat:', chatFiles.join(', '));
}

main();
