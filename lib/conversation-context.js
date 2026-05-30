/**
 * Conversation continuation detection — short replies that only make sense
 * with recent chat history (picking a name from a list, confirming, etc.).
 */

import { getLastPrivateExchangeLocation } from './chat-log.js';

const MAX_CONTINUATION_CHARS = 120;
const MAX_CONTINUATION_WORDS = 12;

function normalizeText(s) {
  return String(s || '').trim();
}

function wordCount(s) {
  return normalizeText(s).split(/\s+/).filter(Boolean).length;
}

/** Last assistant message from LLM history array. */
export function getLastAssistantMessage(historyMessages) {
  if (!Array.isArray(historyMessages)) return '';
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg?.role === 'assistant' && normalizeText(msg.content)) {
      return normalizeText(msg.content);
    }
  }
  return '';
}

/** Last user message before the current turn. */
export function getLastUserMessage(historyMessages) {
  if (!Array.isArray(historyMessages)) return '';
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg?.role === 'user' && normalizeText(msg.content)) {
      return normalizeText(msg.content);
    }
  }
  return '';
}

function hasNumberedOptions(text) {
  return /\n\s*\d+\)/.test(text) || /^\s*\d+\)/m.test(text);
}

function asksForChoice(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  return /\b(tell me your preference|pick one|choose|which one|your preference|confirm)\b/i.test(t);
}

function looksLikeNewQuestion(userText) {
  const u = normalizeText(userText);
  if (/\?\s*$/.test(u)) return true;
  return /^(what|how|when|where|why|who|can you|could you|please|search|look up)\b/i.test(u);
}

function isShortConversationalReply(userText) {
  const u = normalizeText(userText);
  if (!u) return false;
  if (wordCount(u) > 3) return false;
  if (looksLikeNewQuestion(u)) return false;
  if (/^(hi|hey|hello|yo|sup)\b/i.test(u)) return false;
  return true;
}

const CONFIRMATION_REPLY = /^(yes|yep|yeah|yup|no|nope|ok|okay|sure|do it|go ahead|please do|confirm|confirmed|absolutely|definitely|go for it|sounds good|perfect|great|nice)\.?$/i;

function isConfirmationReply(userText) {
  return CONFIRMATION_REPLY.test(normalizeText(userText));
}

function assistantOfferedAction(text) {
  const t = normalizeText(text);
  if (!t) return false;
  return /\b(want me to|shall i|should i|can i|confirm|i'?ll|i will|update|rename|spin up|delegate|ask|ready to|go ahead and)\b/i.test(t)
    || asksForChoice(t);
}

function userTextInAssistantReply(userText, assistantText) {
  const u = normalizeText(userText);
  const a = normalizeText(assistantText);
  if (!u || !a || u.length < 2) return false;
  const escaped = u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(a);
}

/**
 * True when the user message is probably continuing the prior assistant turn
 * (e.g. "Chloe" after a numbered name list), not a standalone lookup query.
 */
export function isLikelyContinuationReply(userText, historyMessages, implicitFeedback) {
  const user = normalizeText(userText);
  if (!user) return false;
  if (user.length > MAX_CONTINUATION_CHARS || wordCount(user) > MAX_CONTINUATION_WORDS) return false;

  const lastAssistant = getLastAssistantMessage(historyMessages);
  if (!lastAssistant && !implicitFeedback) return false;

  if (implicitFeedback && normalizeText(implicitFeedback)) return true;

  if (lastAssistant && userTextInAssistantReply(user, lastAssistant)) return true;

  if (lastAssistant && hasNumberedOptions(lastAssistant) && isShortConversationalReply(user)) {
    if (userTextInAssistantReply(user, lastAssistant)) return true;
    if (wordCount(user) === 1 && /^[A-Za-z][A-Za-z'-]{2,}$/.test(user)) return true;
  }

  if (lastAssistant && asksForChoice(lastAssistant) && isShortConversationalReply(user)) return true;

  if (lastAssistant && isConfirmationReply(user) && assistantOfferedAction(lastAssistant)) return true;

  return false;
}

/** Read implicit-feedback hint written by beforeUserMessage on the previous exchange. */
export function getImplicitContinuationHint(workspaceDir, logJid, sessionId, userText) {
  if (!workspaceDir || !logJid) return '';
  const loc = getLastPrivateExchangeLocation(workspaceDir, logJid, sessionId);
  if (!loc?.row?.retrospective) return '';
  const retro = loc.row.retrospective;
  const next = normalizeText(retro.nextUserMessage);
  const cur = normalizeText(userText);
  if (!next || !cur || next.toLowerCase() !== cur.toLowerCase()) return '';
  return normalizeText(retro.implicitFeedback);
}

/**
 * System-prompt block when the current message continues the prior turn.
 */
export function buildContinuationContextBlock(userText, historyMessages, implicitFeedback) {
  if (!isLikelyContinuationReply(userText, historyMessages, implicitFeedback)) return '';

  const lastAssistant = getLastAssistantMessage(historyMessages);
  const lines = [
    '--- Conversation continuation ---',
    'The user\'s latest message continues the previous exchange. Interpret it in that context.',
    'Do NOT web-search the message in isolation. Do NOT treat a single word as a lookup query.',
  ];
  if (implicitFeedback) {
    lines.push(`Context: ${implicitFeedback}`);
  } else if (lastAssistant) {
    const snippet = lastAssistant.length > 400 ? lastAssistant.slice(0, 400) + '…' : lastAssistant;
    lines.push(`Previous assistant message (for context): ${snippet}`);
  }
  lines.push('---');
  return '\n\n' + lines.join('\n');
}

/** Compact history for intent planner / quality probes (history-blind callers). */
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

/** Skip the post-turn "retry with tools/search" probe for conversational continuations. */
export function shouldSkipToolRetryProbe({ userText, historyMessages, intentPlan, implicitFeedback }) {
  return isLikelyContinuationReply(userText, historyMessages, implicitFeedback);
}

/** User prompt for the answer-completeness probe (includes recent history). */
export function buildAnswerCompletenessProbePrompt(userText, assistantAnswer, historyMessages) {
  const historyBlock = formatHistoryForClassifier(historyMessages, 2);
  const historySection = historyBlock
    ? `Recent conversation:\n${historyBlock}\n\n`
    : '';
  return (
    `${historySection}` +
    `Latest user message: "${normalizeText(userText).slice(0, 300)}"\n\n` +
    `Assistant answered: "${normalizeText(assistantAnswer).slice(0, 300)}"\n\n` +
    `Does the answer fully address the user's latest message in context?\n` +
    `- If the latest message continues the conversation (picking from a list, confirming, naming), ` +
    `a direct conversational reply is complete — do NOT require web search.\n` +
    `- Only mark incomplete if real-time / current web information is genuinely missing.\n\n` +
    `Reply with exactly one of:\n{ "complete": true }\n{ "complete": false }`
  );
}
