/**
 * Chat session: daily boundary, manual new session, log filtering.
 * Usage: node scripts/test/test-chat-session.js
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureChatSession,
  getSessionDayKey,
  isNewSessionRequest,
  isNewSessionOnlyRequest,
  shouldAckNewSessionOnly,
  NEW_SESSION_ACK,
  startNewSession,
} from '../../lib/context/chat-session.js';
import { appendExchange, readLastPrivateExchanges } from '../../lib/context/chat-log.js';

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-session-test-'));
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({
      agents: { defaults: { userTimezone: 'UTC', sessionResetHour: 3 } },
    }, null, 2),
    'utf8'
  );
  process.env.PASTURE_STATE_DIR = stateDir;
  return { stateDir, workspaceDir };
}

async function main() {
  const { workspaceDir } = setup();
  const logKey = 'owner';

  if (!isNewSessionRequest('start a new session')) throw new Error('isNewSessionRequest failed');
  if (isNewSessionRequest('hello there')) throw new Error('false positive isNewSessionRequest');
  if (!isNewSessionOnlyRequest('new session')) throw new Error('isNewSessionOnlyRequest failed');
  if (isNewSessionOnlyRequest('new session, fix agents')) throw new Error('prefix should not be only');
  if (!shouldAckNewSessionOnly('manual', 'new session')) throw new Error('shouldAckNewSessionOnly manual');
  if (shouldAckNewSessionOnly('daily', 'new session')) throw new Error('daily should not ack');
  if (NEW_SESSION_ACK.length < 20) throw new Error('NEW_SESSION_ACK should stay brief');

  const s1 = startNewSession(logKey, 'manual');
  appendExchange(workspaceDir, {
    jid: logKey,
    sessionId: s1.sessionId,
    user: 'old',
    assistant: 'old reply',
    timestampMs: 1,
  });

  const rotated = ensureChatSession(logKey, { userText: 'new session' });
  if (!rotated.rotated || rotated.reason !== 'manual') {
    throw new Error('Expected manual session rotation');
  }

  const history = readLastPrivateExchanges(workspaceDir, logKey, 5, rotated.sessionId);
  if (history.length !== 0) {
    throw new Error('Expected empty history after new session, got ' + history.length);
  }

  appendExchange(workspaceDir, {
    jid: logKey,
    sessionId: rotated.sessionId,
    user: 'hi',
    assistant: 'hello',
    timestampMs: Date.now(),
  });
  const h2 = readLastPrivateExchanges(workspaceDir, logKey, 5, rotated.sessionId);
  if (h2.length < 2) throw new Error('Expected messages in new session');

  const dayKey = getSessionDayKey(new Date('2026-05-28T04:00:00Z'), 'UTC', 3);
  if (dayKey !== '2026-05-28') throw new Error('day key at 4 UTC: ' + dayKey);
  const dayKey2 = getSessionDayKey(new Date('2026-05-28T02:00:00Z'), 'UTC', 3);
  if (dayKey2 !== '2026-05-27') throw new Error('day key at 2 UTC: ' + dayKey2);

  console.log('Chat session test passed.');
}

main().catch((e) => {
  console.error('Chat session test failed:', e.message);
  process.exit(1);
});
