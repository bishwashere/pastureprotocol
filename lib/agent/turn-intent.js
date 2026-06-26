import { runMdPrompt } from './md-llm.js';
import { formatHistoryForClassifier } from '../context/conversation-context.js';

const VALID_MESSAGE_KINDS = ['casual', 'task', 'command', 'reply_to_prompt'];
const VALID_SESSION_ACTIONS = ['none', 'new_session'];
const VALID_REPLY_MODE_ACTIONS = ['none', 'text', 'voice'];
const VALID_WORK_MODE_ACTIONS = ['none', 'single_agent', 'multi_agent'];
const VALID_PROJECT_OR_MISSION_INTENTS = ['none', 'discover', 'continue', 'status'];

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function skillMenu(summaries) {
  return (summaries || [])
    .slice(0, 40)
    .map(({ id, description }) => `  ${id}: ${description || id}`)
    .join('\n') || '  none';
}

/**
 * Unified high-level turn classifier.
 *
 * This is intentionally a thin MD+LLM wrapper. Callers may still keep old JS
 * classifiers as fallbacks while this becomes the single front door for user
 * meaning.
 *
 * @param {{ userText: string, historyMessages?: Array<{role:string,content:string}>, availableSkillIds?: string[], availableSkillSummaries?: Array<{id:string,description:string}>, currentWorkMode?: 'single'|'multi', agentId?: string, llmChat?: Function }} opts
 */
export async function classifyTurnIntent({
  userText,
  historyMessages = [],
  availableSkillIds = [],
  availableSkillSummaries = [],
  currentWorkMode = 'single',
  agentId,
  llmChat: injectedLlmChat = null,
} = {}) {
  const text = String(userText || '').trim();
  if (!text) return null;

  const summaries = Array.isArray(availableSkillSummaries) && availableSkillSummaries.length > 0
    ? availableSkillSummaries
    : (availableSkillIds || []).map((id) => ({ id, description: id }));
  const allowedSkillIds = summaries.map((s) => s.id).filter(Boolean);
  const historyBlock = formatHistoryForClassifier(historyMessages, 4);

  const result = await runMdPrompt({
    promptName: 'turn-intent-classifier',
    user: {
      latestUserMessage: text.slice(0, 1000),
      recentConversation: historyBlock || '',
      currentWorkMode: currentWorkMode === 'multi' ? 'multi' : 'single',
      availableSkills: skillMenu(summaries),
    },
    agentId,
    purpose: 'turn_intent_classifier',
    llmChat: injectedLlmChat,
  });
  if (!result || typeof result !== 'object') return null;

  const candidateSkills = Array.isArray(result.candidate_skills)
    ? result.candidate_skills.filter((id) => typeof id === 'string' && allowedSkillIds.includes(id)).slice(0, 5)
    : [];

  return {
    message_kind: enumValue(result.message_kind, VALID_MESSAGE_KINDS, 'task'),
    session_action: enumValue(result.session_action, VALID_SESSION_ACTIONS, 'none'),
    reply_mode_action: enumValue(result.reply_mode_action, VALID_REPLY_MODE_ACTIONS, 'none'),
    work_mode_action: enumValue(result.work_mode_action, VALID_WORK_MODE_ACTIONS, 'none'),
    should_use_tools: result.should_use_tools === true,
    candidate_skills: candidateSkills,
    project_or_mission_intent: enumValue(result.project_or_mission_intent, VALID_PROJECT_OR_MISSION_INTENTS, 'none'),
    github_source_intent: result.github_source_intent === true,
    confidence: clampConfidence(result.confidence),
    reason: typeof result.reason === 'string' ? result.reason.trim().slice(0, 240) : '',
  };
}

export function buildCasualPlanFromTurnIntent(turnIntent) {
  if (!turnIntent || turnIntent.message_kind !== 'casual') return null;
  if (turnIntent.should_use_tools) return null;
  return {
    mode: 'chat',
    skills: [],
    plan: 'Brief friendly reply only. No tools, web search, URLs, or citations.',
    answer_style: 'short',
  };
}
