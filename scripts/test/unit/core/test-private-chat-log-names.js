/**
 * Private chat log files use human-readable names (telegram-*, whatsapp-*, owner).
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendExchange,
  logJidToFileBase,
  migratePrivateChatLogFileNames,
  readLastPrivateExchanges,
} from '../../../../lib/context/chat-log.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-private-log-names-'));
  const workspaceDir = join(dir, 'workspace');
  const privateDir = join(workspaceDir, 'chat-log', 'private');
  mkdirSync(privateDir, { recursive: true });

  assert(logJidToFileBase('owner') === 'owner', 'owner stays owner');
  assert(logJidToFileBase('123456789') === 'telegram-123456789', 'telegram numeric id');
  assert(logJidToFileBase('15551234567@s.whatsapp.net') === 'whatsapp-15551234567', 'whatsapp jid');

  const tgJid = '987654321';
  appendExchange(workspaceDir, {
    jid: tgJid,
    user: 'hi telegram',
    assistant: 'hello',
    timestampMs: Date.now(),
  });
  const tgPath = join(privateDir, 'telegram-987654321.jsonl');
  assert(existsSync(tgPath), 'telegram log uses human-readable filename');

  const waJid = '15559876543@s.whatsapp.net';
  appendExchange(workspaceDir, {
    jid: waJid,
    user: 'hi whatsapp',
    assistant: 'moo',
    timestampMs: Date.now(),
  });
  const waPath = join(privateDir, 'whatsapp-15559876543.jsonl');
  assert(existsSync(waPath), 'whatsapp log uses human-readable filename');

  // Legacy mangled whatsapp file migrates on startup helper.
  const legacyWaPath = join(privateDir, '15551112222_s_whatsapp_net.jsonl');
  writeFileSync(
    legacyWaPath,
    JSON.stringify({
      ts: Date.now(),
      jid: '15551112222@s.whatsapp.net',
      user: 'legacy wa',
      assistant: 'migrated',
    }) + '\n',
    'utf8',
  );
  const legacyTgPath = join(privateDir, '111222333.jsonl');
  writeFileSync(
    legacyTgPath,
    JSON.stringify({
      ts: Date.now(),
      jid: '111222333',
      user: 'legacy tg',
      assistant: 'migrated',
    }) + '\n',
    'utf8',
  );

  const renames = [];
  const result = migratePrivateChatLogFileNames(workspaceDir, {
    onRenamed(oldRel, newRel) {
      renames.push({ oldRel, newRel });
    },
  });
  assert(result.renamed === 2, `expected 2 renames, got ${result.renamed}`);
  assert(existsSync(join(privateDir, 'whatsapp-15551112222.jsonl')), 'legacy whatsapp renamed');
  assert(existsSync(join(privateDir, 'telegram-111222333.jsonl')), 'legacy telegram renamed');
  assert(!existsSync(legacyWaPath), 'legacy whatsapp file removed');
  assert(!existsSync(legacyTgPath), 'legacy telegram file removed');

  const history = readLastPrivateExchanges(workspaceDir, '111222333', 5);
  assert(history.some((m) => m.content.includes('legacy tg')), 'read via jid finds migrated telegram log');

  console.log('\n| Test | Input | Output | Status |');
  console.log('|------|-------|--------|--------|');
  console.log('| logJidToFileBase | owner | owner | ✅ Pass |');
  console.log('| logJidToFileBase | 123456789 | telegram-123456789 | ✅ Pass |');
  console.log('| logJidToFileBase | 15551234567@s.whatsapp.net | whatsapp-15551234567 | ✅ Pass |');
  console.log('| appendExchange | telegram jid | telegram-987654321.jsonl | ✅ Pass |');
  console.log('| appendExchange | whatsapp jid | whatsapp-15559876543.jsonl | ✅ Pass |');
  console.log('| migratePrivateChatLogFileNames | 2 legacy files | 2 renamed | ✅ Pass |');
  console.log('| readLastPrivateExchanges | migrated jid | history found | ✅ Pass |');
  console.log('\nPrivate chat log names test passed.');
}

main();
