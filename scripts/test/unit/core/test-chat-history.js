#!/usr/bin/env node
/**
 * Chat history depth: default exchanges and resolveChatHistoryExchanges().
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendExchange,
  DEFAULT_CHAT_HISTORY_EXCHANGES,
  readLastPrivateExchanges,
  resolveChatHistoryExchanges,
} from '../../../../lib/context/chat-log.js';
import { startNewSession } from '../../../../lib/context/chat-session.js';

function setupWorkspace() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-chat-history-state-'));
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(join(workspaceDir, 'chat-log', 'private'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), '{}', 'utf8');
  process.env.PASTURE_STATE_DIR = stateDir;
  return workspaceDir;
}

function testDefaults() {
  if (DEFAULT_CHAT_HISTORY_EXCHANGES !== 20) {
    throw new Error(`expected default 20, got ${DEFAULT_CHAT_HISTORY_EXCHANGES}`);
  }
  if (resolveChatHistoryExchanges(undefined) !== 20) {
    throw new Error('resolveChatHistoryExchanges(undefined) should default to 20');
  }
  if (resolveChatHistoryExchanges(8) !== 8) {
    throw new Error('resolveChatHistoryExchanges(8) should be 8');
  }
  if (resolveChatHistoryExchanges(0) !== 20) {
    throw new Error('resolveChatHistoryExchanges(0) should fall back to 20');
  }
}

function testReadLastPrivateExchangesDefault() {
  const workspaceDir = setupWorkspace();
  const logKey = 'test-jid';
  const session = startNewSession(logKey, 'manual');
  for (let i = 0; i < 25; i++) {
    appendExchange(workspaceDir, {
      jid: logKey,
      sessionId: session.sessionId,
      user: `u${i}`,
      assistant: `a${i}`,
      timestampMs: i,
    });
  }
  const history = readLastPrivateExchanges(workspaceDir, logKey, undefined, session.sessionId);
  if (history.length !== DEFAULT_CHAT_HISTORY_EXCHANGES * 2) {
    throw new Error(`expected ${DEFAULT_CHAT_HISTORY_EXCHANGES * 2} messages, got ${history.length}`);
  }
  const firstUser = history.find((m) => m.role === 'user')?.content;
  if (firstUser !== 'u5') {
    throw new Error(`expected oldest included user u5, got ${firstUser}`);
  }
}

async function main() {
  console.log('Chat history depth\n');
  const rows = [];
  let failed = 0;

  for (const [label, fn] of [
    ['defaults', testDefaults],
    ['readLastPrivateExchanges default cap', testReadLastPrivateExchangesDefault],
  ]) {
    process.stdout.write(`  ${label} … `);
    try {
      fn();
      console.log('✅');
      rows.push({ test: label, input: label, output: 'ok', status: '✅ Pass' });
    } catch (err) {
      console.log(`❌  ${err.message}`);
      rows.push({ test: label, input: label, output: err.message, status: '❌ Fail' });
      failed++;
    }
  }

  console.log('\n| Test | Input | Output | Status |');
  console.log('|------|-------|--------|--------|');
  for (const row of rows) {
    console.log(`| ${row.test} | ${row.input} | ${row.output} | ${row.status} |`);
  }

  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('Chat history test failed:', e.message);
  process.exit(1);
});
