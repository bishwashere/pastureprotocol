/**
 * Chat history by day: merge dated jsonl + private jsonl (not memory/YYYY-MM-DD.md)
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  collectChatLogDates,
  readChatLogDayExchanges,
  formatExchangesAsText,
} from '../../lib/context/chat-log.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-chatday-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(join(workspaceDir, 'chat-log', 'private'), { recursive: true });
  const day = '2026-05-27';
  const ts = Date.parse(`${day}T14:30:00Z`);
  writeFileSync(
    join(workspaceDir, 'chat-log', 'private', 'owner.jsonl'),
    JSON.stringify({ ts, user: 'What is the plan?', assistant: 'We ship today.' }) + '\n',
    'utf8'
  );
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true });
  writeFileSync(
    join(workspaceDir, 'memory', day + '.md'),
    'Added reminder: test\n',
    'utf8'
  );
  return { workspaceDir, day };
}

function main() {
  const { workspaceDir, day } = setup();
  const dates = collectChatLogDates(workspaceDir);
  if (!dates.includes(day)) throw new Error('expected day from private chat log');
  const exchanges = readChatLogDayExchanges(workspaceDir, day);
  if (exchanges.length !== 1) throw new Error('expected one exchange for day');
  const text = formatExchangesAsText(exchanges);
  if (!text.includes('What is the plan?')) throw new Error('missing user message from chat log');
  if (text.includes('Added reminder')) throw new Error('must not include memory md reminders');
  console.log('Chat history by day test passed.', dates.join(', '));
}

main();
