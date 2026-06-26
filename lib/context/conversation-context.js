/**
 * Shared helpers for passing recent chat history into classifiers and probes.
 * Context comes from the last N exchanges in the turn — not from special routing rules.
 */

function normalizeText(s) {
  return String(s || '').trim();
}

/**
 * User-channel transcript for this turn (same cap as main). Pair history is separate — see buildPairHistoryContextBlock.
 */
export function resolveSharedTurnHistory(sharedHistoryMessages, pairHistoryMessages) {
  if (Array.isArray(sharedHistoryMessages) && sharedHistoryMessages.length) {
    return sharedHistoryMessages;
  }
  return Array.isArray(pairHistoryMessages) ? pairHistoryMessages : [];
}

/** Extra agent-pair maintenance — additive in the system prompt, never replaces user-channel history. */
export function buildPairHistoryContextBlock(pairHistoryMessages, callerAgentId = 'caller') {
  if (!Array.isArray(pairHistoryMessages) || !pairHistoryMessages.length) return '';
  const formatted = formatHistoryForClassifier(pairHistoryMessages, 20);
  if (!formatted) return '';
  const caller = String(callerAgentId || 'caller').trim() || 'caller';
  return (
    '\n\n# Prior agent-to-agent exchanges with ' + caller + '\n' +
    'Maintenance from past delegations between you and that agent. ' +
    'This is **in addition to** the user chat history for this turn — not a substitute.\n\n' +
    formatted
  );
}

/** Compact history snippet for intent planner / quality probes. */
export function formatHistoryForClassifier(historyMessages, maxExchanges = 3) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return '';
  const n = Math.max(1, Math.floor(Number(maxExchanges)) || 3);
  const pairs = [];
  let currentUser = null;
  for (const msg of historyMessages) {
    if (msg?.role === 'user') currentUser = normalizeText(msg.content);
    else if (msg?.role === 'assistant' && currentUser != null) {
      pairs.push({ user: currentUser, assistant: normalizeText(msg.content) });
      currentUser = null;
    }
  }
  const recent = pairs.slice(-n);
  if (!recent.length) return '';
  return recent
    .map((p, i) => `Turn ${i + 1}:\nUser: ${p.user.slice(0, 300)}\nAssistant: ${p.assistant.slice(0, 400)}`)
    .join('\n\n');
}
