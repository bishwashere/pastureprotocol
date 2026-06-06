import { isNonTaskMessage } from './evaluate-team-capability.js';
import { createGoal } from './goals.js';
import { resolveGoalForUserTurn } from './goals-context.js';

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

function buildMissionSubgoals(userText, agentId) {
  return inferDeliverables(userText).map((title, idx) => ({
    id: `sg-${slugPart(title, `item-${idx + 1}`)}`,
    title: clean(title, 120),
    status: 'todo',
    progress: 0,
    assignee: agentId,
    depends_on: [],
    subgoals: [],
  }));
}

function missionTitleFor(userText) {
  const product = extractProductName(userText);
  if (product) return `Launch ${product}`;
  const firstLine = String(userText || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'New mission';
  return clean(firstLine.replace(/[.!?]+$/g, ''), 80);
}

export function classifyWorkDurability({ userText = '', historyMessages = [], agentId = 'main' } = {}) {
  if (isNonTaskMessage(userText)) {
    return {
      kind: 'direct_answer',
      persistence: 'none',
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
      reason: `Message matches existing goal "${existingGoal.title || existingGoal.id}".`,
    };
  }

  if (looksLikeNewMissionCandidate(userText)) {
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      reason: 'Multi-part launch/project work should be tracked before delegation.',
      title: missionTitleFor(userText),
      subgoals: buildMissionSubgoals(userText, agentId),
    };
  }

  return {
    kind: 'one_off_delegated_answer',
    persistence: 'none',
    reason: 'Task can be answered in the current turn without durable state.',
  };
}

export function prepareWorkDurability(opts = {}) {
  const decision = classifyWorkDurability(opts);
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

export function buildDurabilitySystemBlock(decision) {
  if (!decision || decision.persistence === 'none') return '';
  const lines = [
    '',
    '',
    '# Work durability',
    `Durability classification: ${decision.kind}`,
    `Persistence action: ${decision.persistence}`,
  ];
  if (decision.goalId) lines.push(`Goal ID: ${decision.goalId}`);
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
