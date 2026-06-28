/**
 * Self-inspection classifier.
 *
 * The semantic decision lives in lib/agent/templates/self-inspection-classifier.md.
 * This JS wrapper only runs the MD prompt, validates the JSON shape, and builds a
 * narrow intent plan from the structured result. It does not inspect user text.
 */

import { runMdPrompt } from './md-llm.js';
import { formatHistoryForClassifier } from '../context/conversation-context.js';

const VALID_TARGETS = new Set([
  'runtime_state',
  'source_tree',
  'feature_or_capability',
  'agent_behavior',
  'memory_or_history',
  'unknown',
  'none',
]);

const VALID_STARTING_POINTS = new Set([
  'runtime_home',
  'logs',
  'source_tree',
  'memory',
  'ui_or_http',
]);

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function pickSelfInspectionSkills(availableSkillIds = [], startingPoints = []) {
  const available = new Set(Array.isArray(availableSkillIds) ? availableSkillIds : []);
  const points = new Set(Array.isArray(startingPoints) ? startingPoints : []);
  const skills = [];
  for (const id of ['read', 'go-read', 'core']) {
    if (available.has(id)) skills.push(id);
  }
  if (points.has('ui_or_http') && available.has('http')) skills.push('http');
  return [...new Set(skills)].slice(0, 4);
}

export async function classifySelfInspection({
  userText,
  historyMessages = [],
  agentId,
  llmChat: injectedLlmChat = null,
} = {}) {
  const text = String(userText || '').trim();
  if (!text) return null;

  const result = await runMdPrompt({
    promptName: 'self-inspection-classifier',
    user: {
      latestUserMessage: text.slice(0, 1000),
      recentConversation: formatHistoryForClassifier(historyMessages, 4) || '',
    },
    agentId,
    purpose: 'self_inspection_classifier',
    llmChat: injectedLlmChat,
  });

  if (!result || typeof result !== 'object') return null;
  const target = VALID_TARGETS.has(result.target) ? result.target : 'unknown';
  const startingPoints = Array.isArray(result.starting_points)
    ? result.starting_points.filter((p) => typeof p === 'string' && VALID_STARTING_POINTS.has(p)).slice(0, 4)
    : [];

  return {
    is_self_inspection: result.is_self_inspection === true,
    needs_tools: result.needs_tools === true,
    target,
    starting_points: startingPoints,
    reason: typeof result.reason === 'string' ? result.reason.trim().slice(0, 300) : '',
    confidence: clampConfidence(result.confidence),
  };
}

export function buildSelfInspectionIntentPlan(classification, availableSkillIds = []) {
  if (!classification || classification.is_self_inspection !== true || classification.needs_tools !== true) {
    return null;
  }
  if (classification.confidence < 0.65) return null;

  const skills = pickSelfInspectionSkills(availableSkillIds, classification.starting_points);
  if (skills.length === 0) return null;

  const starts = classification.starting_points.length
    ? classification.starting_points.join(', ')
    : 'runtime_home, source_tree';
  const uiRouteInstruction = classification.starting_points.includes('ui_or_http')
    ? ' For Pasture UI routes, first call go_read_dashboard_url with the route, then probe the returned URL with http.'
    : '';
  return {
    mode: 'tool',
    skills,
    executionMode: 'tool_use',
    usesExistingWorkIntake: false,
    plan:
      `Self-inspection required (${classification.target}). Inspect local Pasture/CowCode evidence before answering. ` +
      `Start with: ${starts}. Treat ~/.pasture as the first runtime source of truth; use source files/logs/state as needed. ` +
      `Do not answer from memory alone.${uiRouteInstruction}`,
    answer_style: 'detailed',
    selfInspection: true,
  };
}
