/**
 * Lightweight intent planner — called once per turn BEFORE getSkillContext().
 * Only needs the user message and the cheap list of enabled skill IDs (no SKILL.md
 * reads, no tool schemas). Returns a routing decision that getSkillContext() uses
 * to load only the relevant schemas, shrinking the context for the main LLM call.
 */

import { chat as llmChat } from '../llm.js';
import { stripThinking } from './agent.js';
import { formatHistoryForClassifier } from './conversation-context.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';

const VALID_MODES = ['chat', 'tool', 'research', 'code', 'memory'];
const VALID_STYLES = ['short', 'detailed'];
const VALID_EXECUTION_MODES = ['direct_answer', 'tool_use', 'delegation', 'persistent_work', 'persistent_delegation'];

/** Fixed plan for greetings / thanks — no LLM planner call, no tools. */
export function buildCasualChatIntentPlan() {
  return {
    mode: 'chat',
    skills: [],
    plan: 'Brief friendly reply only. No tools, web search, URLs, or citations.',
    answer_style: 'short',
  };
}

const PLANNER_SYSTEM =
  'You are an intent classifier. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';

/**
 * Make a single cheap LLM call to plan how to handle the user message.
 * Must be called before getSkillContext() — pass skill summaries (id + description), not schemas.
 *
 * @param {{ userText: string, historyMessages?: Array<{role:string,content:string}>, availableSkillIds?: string[], availableSkillSummaries?: Array<{id:string,description:string}>, agentId?: string, delegationContext?: { candidates?: Array<{agentId:string,title?:string,score:number,matchedSkills?:string[]}>, recommendation?: {targetAgentId:string,score:number,matchedSkills?:string[],reason?:string} }, workDurability?: object }} opts
 * @returns {Promise<{ mode: string, skills: string[], plan: string, answer_style: string } | null>}
 *   Returns null on any failure so callers degrade gracefully (full tool list used).
 */
export async function planIntent({ userText, historyMessages = [], availableSkillIds = [], availableSkillSummaries, agentId, delegationContext = null, workDurability = null, llmChat: injectedLlmChat = null }) {
  if (isNonTaskMessage(userText)) return buildCasualChatIntentPlan();

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
  const durable = workDurability && workDurability.persistence && workDurability.persistence !== 'none'
    ? workDurability
    : null;
  const durabilitySection = (() => {
    if (!durable) return '';
    const lines = [
      'Work durability decision (already decided before this planner):',
      `- kind: ${durable.kind || ''}`,
      `- persistence: ${durable.persistence || ''}`,
      durable.goalId ? `- goalId: ${durable.goalId}` : '',
      durable.taskMatch ? `- taskMatch: ${durable.taskMatch}` : '',
      durable.subgoalId ? `- subgoalId: ${durable.subgoalId}` : '',
      durable.reason ? `- reason: ${durable.reason}` : '',
      '',
      'Planner rule: preserve this durability decision. Do not reclassify persistent work as simple chat.',
      'Prefer executionMode="persistent_delegation" when delegation is recommended; otherwise executionMode="persistent_work".',
      'Prefer skills including "project-workflow" for persistent work intake/state and "agent-send" when delegation is recommended.',
    ].filter(Boolean);
    return lines.join('\n') + '\n\n';
  })();
  const delegationSection = (() => {
    if (!delegationContext || typeof delegationContext !== 'object') return '';
    const teamCapability = delegationContext.teamCapability;
    const candidates = Array.isArray(delegationContext.candidates) ? delegationContext.candidates.slice(0, 5) : [];
    const recommendation = delegationContext.recommendation && typeof delegationContext.recommendation === 'object'
      ? delegationContext.recommendation
      : null;
    if (candidates.length === 0 && !recommendation && !teamCapability) return '';
    const lines = ['Team capability evaluation (pre-computed for this turn):'];
    if (teamCapability?.agents?.length) {
      for (const a of teamCapability.agents.slice(0, 6)) {
        lines.push(`- ${a.agentId}${a.title ? ` (${a.title})` : ''}: ${a.confidencePct} — ${a.reasoning}`);
      }
    } else {
      for (const c of candidates) {
        if (!c || !c.agentId) continue;
        const title = c.title ? ` (${c.title})` : '';
        const skills = Array.isArray(c.matchedSkills) && c.matchedSkills.length > 0
          ? ` matched_skills=${c.matchedSkills.join(',')}`
          : '';
        lines.push(`- ${c.agentId}${title}: score=${Number(c.score || 0)}${skills}`);
      }
    }
    if (recommendation?.action === 'delegate' && recommendation?.targetAgentId) {
      const skills = Array.isArray(recommendation.matchedSkills) && recommendation.matchedSkills.length > 0
        ? ` [${recommendation.matchedSkills.join(', ')}]`
        : '';
      const reason = recommendation.reason ? ` (${recommendation.reason})` : '';
      const via = recommendation.routingMethod === 'llm' ? ' [LLM router]' : '';
      lines.push(`Recommendation: delegate → ${recommendation.targetAgentId}${skills}${reason}${via}`);
      lines.push('Prefer mode="tool" with skills including "agent-send".');
    } else if (recommendation?.action) {
      lines.push(`Recommendation: ${recommendation.action}${recommendation.reason ? ` — ${recommendation.reason}` : ''}`);
      if (recommendation.routingMethod === 'llm' && recommendation.llmReason) {
        lines.push(`LLM router: ${recommendation.llmAction || 'handle-in-main'} (confidence ${Number(recommendation.llmConfidence || 0).toFixed(2)}) — ${recommendation.llmReason}`);
      }
      if (recommendation.offerUpgrade) {
        lines.push('Offer the user: handle as coordinator now, or create a dedicated specialist agent / autonomous Goal for long-term work.');
      }
      if (recommendation.action === 'handle-in-main' || recommendation.action === 'create-new') {
        if (recommendation.routingMethod !== 'llm' || recommendation.llmAction !== 'delegate') {
          lines.push('Do NOT delegate unless the user asks. Answer directly; evaluate-team-capability is already reflected above.');
        }
      }
      if (recommendation.action === 'adapt' && recommendation.targetAgentId) {
        lines.push(`Partial fit: ${recommendation.targetAgentId}. Consider adapt path or cautious delegation.`);
      }
    }
    return lines.join('\n') + '\n\n';
  })();
  const userPrompt =
    `${historySection}` +
    `${durabilitySection}` +
    `${delegationSection}` +
    `Latest user message:\n${userText.slice(0, 600)}\n\n` +
    `Available skills (id: description):\n${skillMenu}\n\n` +
    `Decide:\n` +
    `1. Is this a simple chat answer?\n` +
    `2. Does it need tools?\n` +
    `3. Which 1 to 3 skill IDs from the list above are relevant? (empty array if none)\n` +
    `4. What should be checked before the final answer?\n` +
    `5. If durable work was already identified, preserve it and use existing work intake/state.\n\n` +
    `Return JSON only:\n` +
    `{\n` +
    `  "mode": "chat | tool | research | code | memory",\n` +
    `  "skills": [],\n` +
    `  "executionMode": "direct_answer | tool_use | delegation | persistent_work | persistent_delegation",\n` +
    `  "usesExistingWorkIntake": false,\n` +
    `  "plan": "",\n` +
    `  "answer_style": "short | detailed"\n` +
    `}`;

  try {
    const chatFn = typeof injectedLlmChat === 'function' ? injectedLlmChat : llmChat;
    const raw = await chatFn(
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
    if (durable) {
      plan.mode = plan.mode === 'chat' ? 'tool' : plan.mode;
      const mustHave = [];
      if (allIds.includes('project-workflow')) mustHave.push('project-workflow');
      const rec = delegationContext?.recommendation;
      if (rec?.action === 'delegate' && rec?.targetAgentId && allIds.includes('agent-send')) {
        mustHave.push('agent-send');
      }
      for (const id of mustHave) {
        if (!plan.skills.includes(id)) plan.skills.push(id);
      }
      plan.executionMode = rec?.action === 'delegate' && rec?.targetAgentId
        ? 'persistent_delegation'
        : 'persistent_work';
      plan.usesExistingWorkIntake = true;
    } else {
      plan.executionMode = VALID_EXECUTION_MODES.includes(plan.executionMode)
        ? plan.executionMode
        : (plan.skills.length ? 'tool_use' : 'direct_answer');
      plan.usesExistingWorkIntake = plan.usesExistingWorkIntake === true;
    }
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
    plan.executionMode ? `Execution mode: ${plan.executionMode}` : null,
    plan.usesExistingWorkIntake ? 'Uses existing work intake: true' : null,
    plan.plan ? `Plan: ${plan.plan}` : null,
    `Answer style: ${plan.answer_style}`,
    '---',
  ].filter(Boolean);
  return lines.join('\n');
}
