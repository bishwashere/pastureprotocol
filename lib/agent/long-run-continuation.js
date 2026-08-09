import { runMdPrompt } from './md-llm.js';
import {
  redactTaskWorklogExcerpt,
  redactTaskWorklogText,
} from '../context/task-worklog.js';

const VALID_DECISIONS = new Set(['continue', 'finish', 'stuck']);
const VALID_KEYS = new Set(['decision', 'reason', 'nextStep']);

function safeText(value, max, excerpt = false) {
  const redact = excerpt ? redactTaskWorklogExcerpt : redactTaskWorklogText;
  return redact(value, max).trim();
}

export function normalizeLongRunContinuation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (Object.keys(raw).some((key) => !VALID_KEYS.has(key))) return null;
  if (!VALID_DECISIONS.has(raw.decision)) return null;
  if (typeof raw.reason !== 'string' || typeof raw.nextStep !== 'string') return null;
  const reason = safeText(raw.reason, 500);
  const nextStep = safeText(raw.nextStep, 800);
  if (!reason || (raw.decision === 'continue' && !nextStep)) return null;
  return { decision: raw.decision, reason, nextStep };
}

/** Decide whether a checkpointed run should receive another bounded grant. */
export async function decideLongRunContinuation({
  objective,
  plan = '',
  worklog = '',
  progress = {},
  agentId,
  llmChat = null,
} = {}) {
  const result = await runMdPrompt({
    promptName: 'long-run-continuation',
    user: {
      objective: safeText(objective, 2_000),
      plan: safeText(plan, 4_000),
      progress: safeText(progress, 4_000),
      worklog: safeText(worklog, 24_000, true),
    },
    agentId,
    purpose: 'long_run_continuation',
    maxTokens: 320,
    llmChat,
  });
  return normalizeLongRunContinuation(result);
}
