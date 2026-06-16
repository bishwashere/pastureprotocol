/**
 * Session bootstrap: MEMORY.md + today/yesterday chat logs
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSessionBootstrapContext,
  getTodayAndYesterdayDates,
} from '../../lib/agent/session-bootstrap.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-bootstrap-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(join(workspaceDir, 'chat-log', 'private'), { recursive: true });
  writeFileSync(join(workspaceDir, 'MEMORY.md'), '# Notes\nRemember the API key.', 'utf8');
  const now = new Date('2026-05-28T15:00:00Z');
  const { today, yesterday } = getTodayAndYesterdayDates(now, 'UTC');
  const todayTs = Date.parse(`${today}T12:00:00Z`);
  const yesterdayTs = Date.parse(`${yesterday}T12:00:00Z`);
  writeFileSync(
    join(workspaceDir, 'chat-log', `${today}.jsonl`),
    JSON.stringify({ ts: todayTs, user: 'Hi today', assistant: 'Hello today' }) + '\n',
    'utf8'
  );
  writeFileSync(
    join(workspaceDir, 'chat-log', `${yesterday}.jsonl`),
    JSON.stringify({ ts: yesterdayTs, user: 'Hi yesterday', assistant: 'Hello yesterday' }) + '\n',
    'utf8'
  );
  return { workspaceDir, today, yesterday, now };
}

async function main() {
  const { workspaceDir, today, yesterday, now } = setup();
  const { block, sources } = buildSessionBootstrapContext(workspaceDir, { now, tz: 'UTC' });
  if (!block.includes('MEMORY.md')) throw new Error('missing MEMORY.md in bootstrap');
  if (!block.includes('Remember the API key')) throw new Error('missing MEMORY.md content');
  if (!block.includes(`chat-log/${today}.jsonl`)) throw new Error('missing today chat log');
  if (!block.includes(`chat-log/${yesterday}.jsonl`)) throw new Error('missing yesterday chat log');
  if (!block.includes('Hi today')) throw new Error('missing today chat content');
  if (!block.includes('Hi yesterday')) throw new Error('missing yesterday chat content');
  if (!sources.includes('MEMORY.md')) throw new Error('sources missing MEMORY.md');
  console.log('Session bootstrap test passed.', sources.join(', '));
}

main().catch((e) => {
  console.error('Session bootstrap test failed:', e.message);
  process.exit(1);
});
