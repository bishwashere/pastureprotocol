/**
 * Legacy chat-log/YYYY-MM-DD.jsonl migrates into chat-log/private/.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { migrateLegacyDatedChatLogs, readChatLogDayExchanges } from '../../lib/context/chat-log.js';

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-legacy-chat-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(join(workspaceDir, 'chat-log'), { recursive: true });
  const day = '2026-05-27';
  const ts = Date.parse(`${day}T14:30:00Z`);
  writeFileSync(
    join(workspaceDir, 'chat-log', `${day}.jsonl`),
    JSON.stringify({ ts, jid: 'owner', user: 'legacy?', assistant: 'migrated.' }) + '\n',
    'utf8',
  );

  const result = migrateLegacyDatedChatLogs(workspaceDir);
  if (result.files !== 1 || result.lines !== 1) {
    throw new Error(`expected 1 file/1 line migrated, got ${result.files}/${result.lines}`);
  }
  if (existsSync(join(workspaceDir, 'chat-log', `${day}.jsonl`))) {
    throw new Error('legacy dated file should be removed after migration');
  }
  const privatePath = join(workspaceDir, 'chat-log', 'private', 'owner.jsonl');
  if (!existsSync(privatePath)) throw new Error('expected private/owner.jsonl after migration');
  const body = readFileSync(privatePath, 'utf8');
  if (!body.includes('legacy?')) throw new Error('migrated content missing user text');
  const exchanges = readChatLogDayExchanges(workspaceDir, day);
  if (exchanges.length !== 1) throw new Error('expected one exchange for migrated day');
  console.log('Legacy chat-log migration test passed.');
}

main();
