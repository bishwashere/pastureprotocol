import { runMdPrompt } from './md-llm.js';
import { formatHistoryForClassifier } from '../context/conversation-context.js';

const VALID_ROUTES = new Set(['simple_chat', 'simple_live_lookup', 'existing_pipeline']);
const FAST_CONFIDENCE_THRESHOLD = 0.9;

function clean(text, max = 800) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function confidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeSkills(skills, availableSkillIds = []) {
  const available = new Set((availableSkillIds || []).map(String));
  const out = [];
  for (const raw of Array.isArray(skills) ? skills : []) {
    const id = String(raw || '').trim();
    if (!id || !available.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 3) break;
  }
  return out;
}

function frameForTriage(frame) {
  if (!frame || typeof frame !== 'object') return null;
  return {
    status: clean(frame.status, 40),
    kind: clean(frame.kind, 40),
    title: clean(frame.title, 120),
    objective: clean(frame.objective, 240),
    projectName: clean(frame.projectName, 120),
    ownerAgentId: clean(frame.ownerAgentId, 80),
    toolProfile: Array.isArray(frame.toolProfile) ? frame.toolProfile.map(String).slice(0, 8) : [],
    lastUserText: clean(frame.lastUserText, 180),
    lastAssistantText: clean(frame.lastAssistantText, 180),
    hasWorklog: Boolean(frame.worklogId),
  };
}

export async function planFastTurnTriage({
  userText,
  historyMessages = [],
  availableSkillIds = [],
  currentWorkMode = 'single',
  activeFrame = null,
  agentId,
  llmChat = null,
} = {}) {
  const result = await runMdPrompt({
    promptName: 'fast-turn-triage',
    user: {
      latestUserMessage: clean(userText, 1000),
      recentConversation: formatHistoryForClassifier(historyMessages, 3),
      currentWorkMode: currentWorkMode === 'multi' ? 'multi' : 'single',
      activeFrame: frameForTriage(activeFrame),
      availableSkillIds: (availableSkillIds || []).map(String).slice(0, 40),
    },
    agentId,
    purpose: 'fast_turn_triage',
    llmChat,
    maxTokens: 320,
  });

  if (!result || typeof result !== 'object') return null;
  const route = VALID_ROUTES.has(result.route) ? result.route : 'existing_pipeline';
  const conf = confidence(result.confidence);
  const skills = route === 'simple_chat' ? [] : normalizeSkills(result.skills, availableSkillIds);
  const liveLookupHasTool = route !== 'simple_live_lookup' || skills.length > 0;
  const safeRoute = conf >= FAST_CONFIDENCE_THRESHOLD && liveLookupHasTool
    ? route
    : 'existing_pipeline';

  return {
    route: safeRoute,
    rawRoute: route,
    confidence: conf,
    skills: safeRoute === 'simple_chat' ? [] : skills,
    mustUseTool: safeRoute === 'simple_live_lookup' ? true : result.mustUseTool === true,
    skipCompletenessProbe: result.skipCompletenessProbe === true,
    plan: clean(result.plan, 500),
    reason: clean(result.reason, 300),
  };
}

export function fastTriageToTurnRoute(triage) {
  if (!triage || triage.route === 'existing_pipeline') return null;
  return {
    mode: triage.route === 'simple_live_lookup' ? 'tool' : 'chat',
    skills: Array.isArray(triage.skills) ? triage.skills : [],
    requiredToolSteps: triage.route === 'simple_live_lookup' && Array.isArray(triage.skills) && triage.skills.includes('search')
      ? [{ kind: 'inspect', anyOfSkills: ['search'], anyOfTools: ['search_search', 'search_navigate'], requiredArguments: {}, resultContains: '' }]
      : [],
    executionMode: triage.route === 'simple_live_lookup' ? 'tool_use' : 'direct_answer',
    usesExistingWorkIntake: false,
    mustUseTool: triage.mustUseTool === true,
    needsWorklog: false,
    plan: triage.plan || (triage.route === 'simple_live_lookup'
      ? 'Use the minimal lookup tool and answer concisely.'
      : 'Answer briefly without tools.'),
    answer_style: 'short',
    fastTriage: true,
    skipCompletenessProbe: triage.skipCompletenessProbe === true,
  };
}
