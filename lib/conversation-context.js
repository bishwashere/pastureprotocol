/**
 * Shared helpers for passing recent chat history into classifiers and probes.
 * Context comes from the last N exchanges in the turn — not from special routing rules.
 */

import { isWorkOrDiscoveryRequest } from './goals-context.js';
import { INCOHERENT_ANSWER_PROBE_HINT } from './user-reply-style.js';

function normalizeText(s) {
  return String(s || '').trim();
}

/**
 * Delegated agents use the same user-channel history as the caller when available.
 * Falls back to agent-pair history for nested-only or internal-only turns.
 */
export function resolveSharedTurnHistory(sharedHistoryMessages, pairHistoryMessages) {
  if (Array.isArray(sharedHistoryMessages) && sharedHistoryMessages.length) {
    return sharedHistoryMessages;
  }
  return Array.isArray(pairHistoryMessages) ? pairHistoryMessages : [];
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

/** User prompt for the post-turn completeness probe (includes recent history). */
export function buildAnswerCompletenessProbePrompt(userText, assistantAnswer, historyMessages) {
  const historyBlock = formatHistoryForClassifier(historyMessages, 2);
  const historySection = historyBlock
    ? `Recent conversation:\n${historyBlock}\n\n`
    : '';
  const workHint = isWorkOrDiscoveryRequest(userText)
    ? '- The user asked to learn or continue **work** (find out, what is it about, etc.). Mark **incomplete** if the assistant only asked them to pick a source (GitHub vs path vs tracker) without using tools first when an **Active goal** or URL was available.\n'
    : '';
  return (
    `${historySection}` +
    `Latest user message: "${normalizeText(userText).slice(0, 300)}"\n\n` +
    `Assistant answered: "${normalizeText(assistantAnswer).slice(0, 300)}"\n\n` +
    `Given the recent conversation, does the answer fully address the latest message?\n` +
    `- Short replies (names, yes/no, confirmations) are usually complete when they follow clearly from the thread.\n` +
    workHint +
    '- Mark incomplete if the assistant should have used tools (web, github, files) but gave only clarifying questions.\n' +
    INCOHERENT_ANSWER_PROBE_HINT +
    '- Only mark complete if the user got a real answer grounded in findings.\n\n' +
    `Reply with exactly one of:\n{ "complete": true }\n{ "complete": false }`
  );
}
