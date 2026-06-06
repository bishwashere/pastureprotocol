import { isNonTaskMessage } from './evaluate-team-capability.js';
import { createGoal, listGoals } from './goals.js';
import { resolveGoalForUserTurn } from './goals-context.js';
import { chat as defaultLlmChat } from '../llm.js';

const DURABILITY_SYSTEM =
  'You are a work durability classifier. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';
const GOAL_RESOLUTION_SYSTEM =
  'You are a goal and task matcher for follow-up chat messages. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';

const VALID_WORK_MODES = new Set([
  'direct_answer',
  'one_off_delegated_answer',
  'existing_goal_task_update',
  'new_mission_candidate',
]);

function clean(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function slugPart(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return s || fallback;
}

function extractProductName(userText) {
  const text = String(userText || '');
  const direct = text.match(/\b(?:called|named)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/);
  if (direct) return direct[1];
  const launch = text.match(/\b(?:launching|launch)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/);
  if (launch) return launch[1];
  return '';
}

function stripJsonFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

function flattenSubgoals(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenSubgoals(sg.subgoals, out);
  }
  return out;
}

function recentActiveGoalsForResolution(limit = 8) {
  try {
    const goals = listGoals().goals || [];
    return goals
      .filter((g) => String(g.status || 'active').toLowerCase() === 'active')
      .sort((a, b) => {
        const bTs = Number(b.updatedAt || b.lastRunAt || b.createdAt || 0);
        const aTs = Number(a.updatedAt || a.lastRunAt || a.createdAt || 0);
        return bTs - aTs;
      })
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

function formatGoalsForAiResolution(goals) {
  return (goals || []).map((goal) => {
    const subs = flattenSubgoals(goal.subgoals || [])
      .slice(0, 12)
      .map((sg) => `    - ${sg.id || ''}: ${sg.title || ''} [${sg.status || 'todo'}]`)
      .join('\n');
    return [
      `- goalId: ${goal.id}`,
      `  title: ${goal.title || ''}`,
      `  objective: ${clean(goal.objective || '', 220)}`,
      `  owner: ${goal.ownerAgentId || ''}`,
      subs ? `  subgoals:\n${subs}` : '',
      goal.lastActivity ? `  lastActivity: ${clean(goal.lastActivity, 180)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function findSubgoalMatch(goal, taskMatch) {
  const match = clean(taskMatch, 120).toLowerCase();
  if (!goal || !match) return null;
  return flattenSubgoals(goal.subgoals || []).find((sg) => {
    const id = String(sg.id || '').toLowerCase();
    const title = String(sg.title || '').toLowerCase();
    return id === match || title.includes(match) || match.includes(title);
  }) || null;
}

function normalizeAiGoalResolution(parsed, goals) {
  const goalMatch = String(parsed?.goalMatch || parsed?.match || '').trim();
  const goalId = String(parsed?.goalId || '').trim();
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  if (!goalId || confidence < 0.65) return null;
  if (!['recent_goal', 'existing_goal', 'active_goal'].includes(goalMatch)) return null;
  const goal = (goals || []).find((g) => String(g.id || '') === goalId);
  if (!goal) return null;
  const taskMatch = clean(parsed?.taskMatch || parsed?.subgoalId || parsed?.subgoal || '', 120);
  const subgoal = findSubgoalMatch(goal, taskMatch);
  return {
    kind: 'existing_goal_task_update',
    persistence: 'attach_existing_goal',
    goalId: goal.id,
    goal,
    taskMatch,
    subgoalId: subgoal?.id || '',
    confidence,
    classifier: 'ai-goal-resolution',
    reason: clean(parsed?.reason || `AI matched this follow-up to "${goal.title || goal.id}".`, 240),
  };
}

async function resolveGoalForUserTurnWithAi(opts = {}) {
  const goals = recentActiveGoalsForResolution();
  if (!goals.length) return null;
  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;
  const history = (opts.historyMessages || [])
    .slice(-6)
    .map((m) => `${m.role || 'user'}: ${String(m.content || '').slice(0, 220)}`)
    .join('\n');
  const prompt = [
    history ? `Recent conversation:\n${history}\n` : '',
    `Latest user message:\n${String(opts.userText || '').slice(0, 800)}`,
    '',
    'Recent active goals and tasks:',
    formatGoalsForAiResolution(goals) || '(none)',
    '',
    'Decide whether the latest message is a follow-up/update to one of these goals or subgoals.',
    'Only match when the reference is reasonably clear from wording or recent context.',
    'Return JSON only:',
    '{',
    '  "goalMatch": "recent_goal | existing_goal | none",',
    '  "goalId": "",',
    '  "taskMatch": "",',
    '  "confidence": 0.0,',
    '  "reason": "one sentence"',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: GOAL_RESOLUTION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { agentId: opts.agentId || 'main' },
    );
    return normalizeAiGoalResolution(JSON.parse(stripJsonFences(raw)), goals);
  } catch (err) {
    console.log('[work-durability] ai goal resolution failed, continuing:', err?.message || err);
    return null;
  }
}

function parseNumberedDeliverables(userText) {
  const out = [];
  const lines = String(userText || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!m) continue;
    const item = clean(m[1], 120);
    if (item && !out.includes(item)) out.push(item);
  }
  return out.slice(0, 8);
}

function inferDeliverables(userText) {
  const text = String(userText || '').toLowerCase();
  const items = parseNumberedDeliverables(userText);
  const push = (label) => {
    if (!items.some((item) => item.toLowerCase().includes(label.toLowerCase()))) items.push(label);
  };
  if (/\bpositioning|value prop|tagline\b/.test(text)) push('Positioning statement');
  if (/\bposts?|threads?|launch content|social\b/.test(text)) push('Launch posts');
  if (/\blanding page|checklist\b/.test(text)) push('Landing page checklist');
  if (/\banalytics|funnel|instrument|metrics\b/.test(text)) push('Analytics and measurement plan');
  return items.slice(0, 8);
}

function looksLikeNewMissionCandidate(userText) {
  const text = String(userText || '').toLowerCase();
  if (!text.trim() || isNonTaskMessage(userText)) return false;
  const deliverables = inferDeliverables(userText);
  const hasDurableVerb = /\b(launch|launching|ship|build|prepare|plan|campaign|project|next week|this week|roadmap)\b/.test(text);
  return hasDurableVerb && deliverables.length >= 2;
}

function buildMissionSubgoals(userText, agentId, deliverables = []) {
  const titles = Array.isArray(deliverables) && deliverables.length
    ? deliverables.map((d) => clean(d, 120)).filter(Boolean)
    : inferDeliverables(userText);
  return titles.map((title, idx) => ({
    id: `sg-${slugPart(title, `item-${idx + 1}`)}`,
    title: clean(title, 120),
    status: 'todo',
    progress: 0,
    assignee: agentId,
    depends_on: [],
    subgoals: [],
  }));
}

function missionTitleFor(userText, projectName = '') {
  const product = clean(projectName, 60) || extractProductName(userText);
  if (product) return `Launch ${product}`;
  const firstLine = String(userText || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'New mission';
  return clean(firstLine.replace(/[.!?]+$/g, ''), 80);
}

function deterministicFastPath({ userText = '', historyMessages = [], agentId = 'main' } = {}) {
  if (isNonTaskMessage(userText)) {
    return {
      kind: 'direct_answer',
      persistence: 'none',
      confidence: 1,
      classifier: 'deterministic',
      reason: 'Simple chat does not need persistent work state.',
    };
  }

  const existingGoal = resolveGoalForUserTurn({ userText, historyMessages, agentId });
  if (existingGoal) {
    return {
      kind: 'existing_goal_task_update',
      persistence: 'attach_existing_goal',
      goalId: existingGoal.id,
      goal: existingGoal,
      confidence: 1,
      classifier: 'deterministic',
      reason: `Message matches existing goal "${existingGoal.title || existingGoal.id}".`,
    };
  }

  const text = String(userText || '').toLowerCase();
  if (/^\s*(remind me|reminder|set a reminder)\b/.test(text)) {
    return {
      kind: 'one_off_delegated_answer',
      persistence: 'none',
      confidence: 1,
      classifier: 'deterministic',
      reason: 'Reminder requests are handled by cron, not mission persistence.',
    };
  }

  if (/^\s*(what is|who is|define|explain)\b/.test(text) && !/\b(next week|this week|launch|build|ship|prepare|plan)\b/.test(text)) {
    return {
      kind: 'direct_answer',
      persistence: 'none',
      confidence: 0.9,
      classifier: 'deterministic',
      reason: 'Simple explanation question does not need persistent work state.',
    };
  }

  return null;
}

function fallbackRuleDecision({ userText = '', agentId = 'main' } = {}) {
  if (looksLikeNewMissionCandidate(userText)) {
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      confidence: 0.75,
      classifier: 'deterministic',
      reason: 'Multi-part launch/project work should be tracked before delegation.',
      title: missionTitleFor(userText),
      subgoals: buildMissionSubgoals(userText, agentId),
    };
  }

  return {
    kind: 'one_off_delegated_answer',
    persistence: 'none',
    confidence: 0.7,
    classifier: 'deterministic',
    reason: 'Task can be answered in the current turn without durable state.',
  };
}

export function classifyWorkDurability({ userText = '', historyMessages = [], agentId = 'main' } = {}) {
  return deterministicFastPath({ userText, historyMessages, agentId })
    || fallbackRuleDecision({ userText, agentId });
}

function normalizeAiDecision(parsed, opts = {}) {
  const userText = opts.userText || '';
  const agentId = opts.agentId || 'main';
  const workMode = String(parsed?.workMode || parsed?.kind || '').trim();
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  if (!VALID_WORK_MODES.has(workMode)) return null;

  const requiresPersistence = parsed?.requiresPersistence === true;
  const reason = clean(parsed?.reason || '', 240);
  const projectName = clean(parsed?.projectName || parsed?.project || '', 80);
  const deliverables = Array.isArray(parsed?.deliverables)
    ? parsed.deliverables.map((d) => clean(d, 120)).filter(Boolean).slice(0, 8)
    : [];

  if (requiresPersistence && workMode === 'new_mission_candidate' && confidence >= 0.6) {
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      confidence,
      classifier: 'ai',
      reason: reason || 'AI classified this as durable multi-step work.',
      projectName,
      title: missionTitleFor(userText, projectName),
      subgoals: buildMissionSubgoals(userText, agentId, deliverables),
    };
  }

  return {
    kind: workMode,
    persistence: 'none',
    confidence,
    classifier: 'ai',
    reason: reason || 'AI classified this as non-persistent current-turn work.',
    projectName,
  };
}

export async function classifyWorkDurabilityWithAi(opts = {}) {
  const fast = deterministicFastPath(opts);
  if (fast) return fast;

  const fallback = fallbackRuleDecision(opts);
  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;
  const goalResolution = await resolveGoalForUserTurnWithAi({ ...opts, llmChat });
  if (goalResolution) return goalResolution;

  const history = (opts.historyMessages || [])
    .slice(-4)
    .map((m) => `${m.role || 'user'}: ${String(m.content || '').slice(0, 180)}`)
    .join('\n');
  const prompt = [
    history ? `Recent conversation:\n${history}\n` : '',
    `Latest user message:\n${String(opts.userText || '').slice(0, 1000)}`,
    '',
    'Classify whether this chat turn needs durable work state before any delegation.',
    'Use deterministic common sense:',
    '- direct answers and simple questions do not need persistence',
    '- reminders are scheduler/cron work, not missions',
    '- future project/launch/build/campaign work with multiple deliverables should be a new_mission_candidate',
    '- updates to existing ongoing work should be existing_goal_task_update only if the message clearly refers to that work',
    '',
    'Return JSON only:',
    '{',
    '  "workMode": "direct_answer | one_off_delegated_answer | existing_goal_task_update | new_mission_candidate",',
    '  "requiresPersistence": true,',
    '  "confidence": 0.0,',
    '  "reason": "one sentence",',
    '  "projectName": "",',
    '  "deliverables": []',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: DURABILITY_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { agentId: opts.agentId || 'main' },
    );
    const parsed = JSON.parse(stripJsonFences(raw));
    const normalized = normalizeAiDecision(parsed, opts);
    return normalized || fallback;
  } catch (err) {
    console.log('[work-durability] ai classifier failed, using deterministic fallback:', err?.message || err);
    return fallback;
  }
}

export function prepareWorkDurability(opts = {}) {
  const decision = classifyWorkDurability(opts);
  return persistDurabilityDecision(decision, opts);
}

function persistDurabilityDecision(decision, opts = {}) {
  if (decision.persistence !== 'create_lightweight_mission') return decision;

  const agentId = String(opts.agentId || 'main').trim() || 'main';
  const goal = createGoal({
    title: decision.title,
    objective: clean(opts.userText, 360),
    ownerAgentId: agentId,
    status: 'active',
    intervalMs: 60_000,
    subgoals: decision.subgoals,
  });

  return {
    ...decision,
    goalId: goal.id,
    goal,
    createdGoal: true,
  };
}

export async function prepareWorkDurabilityWithAi(opts = {}) {
  const decision = await classifyWorkDurabilityWithAi(opts);
  return persistDurabilityDecision(decision, opts);
}

export function buildDurabilitySystemBlock(decision) {
  if (!decision || decision.persistence === 'none') return '';
  const lines = [
    '',
    '',
    '# Work durability',
    `Durability classification: ${decision.kind}`,
    `Persistence action: ${decision.persistence}`,
  ];
  if (decision.classifier) lines.push(`Classifier: ${decision.classifier}`);
  if (Number.isFinite(Number(decision.confidence))) lines.push(`Confidence: ${Number(decision.confidence).toFixed(2)}`);
  if (decision.goalId) lines.push(`Goal ID: ${decision.goalId}`);
  if (decision.taskMatch) lines.push(`Task match: ${decision.taskMatch}`);
  if (decision.subgoalId) lines.push(`Subgoal ID: ${decision.subgoalId}`);
  if (decision.reason) lines.push(`Reason: ${decision.reason}`);
  if (Array.isArray(decision.subgoals) && decision.subgoals.length) {
    lines.push('Initial subgoals:');
    decision.subgoals.forEach((sg) => lines.push(`- [${sg.status || 'todo'}] ${sg.title}`));
  }
  return lines.join('\n');
}

export function delegationArgsFromDurability(decision, userText) {
  if (!decision || !decision.goalId) return {};
  const title = decision.goal?.title || decision.title || clean(userText, 120);
  const expected = Array.isArray(decision.subgoals) && decision.subgoals.length
    ? decision.subgoals.map((sg) => sg.title).join('; ')
    : clean(userText, 240);
  return {
    goalId: decision.goalId,
    taskTitle: title,
    expectedOutput: expected,
  };
}

export function delegationRoutingTextFromDurability(decision, userText) {
  if (!decision || decision.persistence === 'none') return userText;
  const subgoalText = Array.isArray(decision.subgoals)
    ? decision.subgoals.map((sg) => sg.title).join(' ')
    : '';
  const blob = `${userText} ${decision.title || ''} ${subgoalText}`.toLowerCase();
  const hints = [];
  if (/\b(positioning|posts?|landing page|launch content|campaign|tagline|brand)\b/.test(blob)) {
    hints.push('marketing campaign positioning launch posts landing page');
  }
  if (/\b(analytics|funnel|instrument|tracking|metrics|implementation|ci|github|code)\b/.test(blob)) {
    hints.push('technical implementation analytics engineering');
  }
  return [userText, subgoalText, ...hints].filter(Boolean).join('\n');
}
