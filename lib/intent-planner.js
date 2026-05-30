/**
 * Lightweight intent planner — called once per turn BEFORE getSkillContext().
 * Only needs the user message and the cheap list of enabled skill IDs (no SKILL.md
 * reads, no tool schemas). Returns a routing decision that getSkillContext() uses
 * to load only the relevant schemas, shrinking the context for the main LLM call.
 */

import { chat as llmChat } from '../llm.js';
import { stripThinking } from './agent.js';
import { formatHistoryForClassifier } from './conversation-context.js';

const VALID_MODES = ['chat', 'tool', 'research', 'code', 'memory'];
const VALID_STYLES = ['short', 'detailed'];

const PLANNER_SYSTEM =
  'You are an intent classifier. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';

/**
 * Make a single cheap LLM call to plan how to handle the user message.
 * Must be called before getSkillContext() — pass skill summaries (id + description), not schemas.
 *
 * @param {{ userText: string, historyMessages?: Array<{role:string,content:string}>, availableSkillIds?: string[], availableSkillSummaries?: Array<{id:string,description:string}>, agentId?: string }} opts
 * @returns {Promise<{ mode: string, skills: string[], plan: string, answer_style: string } | null>}
 *   Returns null on any failure so callers degrade gracefully (full tool list used).
 */
export async function planIntent({ userText, historyMessages = [], availableSkillIds = [], availableSkillSummaries, agentId }) {
  // Build a skill menu with descriptions when available, plain IDs otherwise.
  const summaries = Array.isArray(availableSkillSummaries) && availableSkillSummaries.length > 0
    ? availableSkillSummaries
    : availableSkillIds.map((id) => ({ id, description: id }));
  const skillMenu = summaries
    .slice(0, 30)
    .map(({ id, description }) => `  ${id}: ${description}`)
    .join('\n') || '  none';
  const allIds = summaries.map((s) => s.id);
  const historyBlock = formatHistoryForClassifier(historyMessages, 3);
  const historySection = historyBlock ? `Recent conversation:\n${historyBlock}\n\n` : '';
  const userPrompt =
    `${historySection}` +
    `Latest user message:\n${userText.slice(0, 600)}\n\n` +
    `Available skills (id: description):\n${skillMenu}\n\n` +
    `Decide:\n` +
    `1. Is this a simple chat answer?\n` +
    `2. Does it need tools?\n` +
    `3. Which 1 to 3 skill IDs from the list above are relevant? (empty array if none)\n` +
    `4. What should be checked before the final answer?\n\n` +
    `Return JSON only:\n` +
    `{\n` +
    `  "mode": "chat | tool | research | code | memory",\n` +
    `  "skills": [],\n` +
    `  "plan": "",\n` +
    `  "answer_style": "short | detailed"\n` +
    `}`;

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: PLANNER_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      { agentId },
    );

    const cleaned = stripThinking(raw || '')
      .trim()
      .replace(/^```[a-z]*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    const plan = JSON.parse(cleaned);

    plan.mode = VALID_MODES.includes(plan.mode) ? plan.mode : 'chat';
    // Only keep skill IDs that actually exist in the available list (guard hallucinations).
    plan.skills = Array.isArray(plan.skills)
      ? plan.skills.filter((s) => typeof s === 'string' && allIds.includes(s))
      : [];
    plan.plan = typeof plan.plan === 'string' ? plan.plan.trim() : '';
    plan.answer_style = VALID_STYLES.includes(plan.answer_style) ? plan.answer_style : 'short';

    return plan;
  } catch (err) {
    console.log('[intent-planner] failed, skipping (full tool list will be used):', err.message);
    return null;
  }
}

/**
 * Convert a plan object into a compact block appended to the system prompt
 * so the main agent turn has explicit routing context.
 *
 * @param {{ mode: string, skills: string[], plan: string, answer_style: string } | null} plan
 * @returns {string}
 */
export function intentPlanToSystemBlock(plan) {
  if (!plan) return '';
  const lines = [
    '--- Intent Plan ---',
    `Mode: ${plan.mode}`,
    plan.skills.length ? `Skills: ${plan.skills.join(', ')}` : null,
    plan.plan ? `Plan: ${plan.plan}` : null,
    `Answer style: ${plan.answer_style}`,
    '---',
  ].filter(Boolean);
  return lines.join('\n');
}
