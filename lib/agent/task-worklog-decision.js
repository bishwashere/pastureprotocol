import { runMdPrompt } from './md-llm.js';

function clean(text, max = 2_000) {
  const value = String(text || '').trim();
  return value.length > max ? value.slice(0, max) : value;
}

/** Shared MD-backed fallback for agent entry points without a unified route. */
export async function decideTaskWorklog({
  userText,
  hasTools = false,
  agentId,
  llmChat = null,
} = {}) {
  if (!hasTools) return { needsWorklog: false, reason: 'No tools are available.' };
  const result = await runMdPrompt({
    promptName: 'task-worklog-decision',
    user: {
      request: clean(userText),
      hasTools: true,
    },
    agentId,
    purpose: 'task_worklog_decision',
    maxTokens: 220,
    llmChat,
  });
  if (!result || typeof result !== 'object') return null;
  return {
    needsWorklog: result.needsWorklog === true,
    reason: clean(result.reason, 300),
  };
}
