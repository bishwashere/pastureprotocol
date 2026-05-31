/**
 * Live per-agent working memory — present-tense brain state for the dashboard.
 * Separate from team activity / inbox (history).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getAgentContextStatePath } from './paths.js';
import { parseInternalPairJid, extractProjectContext } from './team-inbox.js';

const VALID_STATES = new Set(['idle', 'working', 'blocked']);
const MAX_CONTEXT = 8;
const MAX_FACTS = 8;

function readStore() {
  const path = getAgentContextStatePath();
  try {
    if (!existsSync(path)) return { agents: {}, updatedAt: 0 };
    const raw = readFileSync(path, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return {
      agents: parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {},
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return { agents: {}, updatedAt: 0 };
  }
}

function writeStore(store) {
  try {
    const path = getAgentContextStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      agents: store.agents || {},
      updatedAt: Date.now(),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {
    // Never break agent execution.
  }
}

function normalizeAgentRow(agentId, row = {}) {
  const state = VALID_STATES.has(row.state) ? row.state : 'idle';
  return {
    agentId: String(agentId || '').trim(),
    state,
    currentGoal: typeof row.currentGoal === 'string' ? row.currentGoal.trim() : '',
    currentStep: typeof row.currentStep === 'string' ? row.currentStep.trim() : '',
    waitingFor: typeof row.waitingFor === 'string' ? row.waitingFor.trim() : '',
    context: Array.isArray(row.context) ? row.context.map(String).filter(Boolean).slice(0, MAX_CONTEXT) : [],
    knownFacts: Array.isArray(row.knownFacts) ? row.knownFacts.map(String).filter(Boolean).slice(0, MAX_FACTS) : [],
    updatedAt: Number(row.updatedAt) || Date.now(),
  };
}

function upsertAgent(agentId, patch) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const store = readStore();
  const prev = normalizeAgentRow(id, store.agents[id] || {});
  const next = normalizeAgentRow(id, {
    ...prev,
    ...patch,
    agentId: id,
    updatedAt: Date.now(),
  });
  store.agents[id] = next;
  writeStore(store);
  return next;
}

function pushUnique(list, value, max = MAX_CONTEXT) {
  const v = String(value || '').trim();
  if (!v) return list;
  const out = Array.isArray(list) ? list.slice() : [];
  if (!out.includes(v)) out.push(v);
  return out.slice(-max);
}

function summarizeTask(text, maxLen = 120) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

function inferGoal(userText, { delegated = false } = {}) {
  const t = String(userText || '').toLowerCase();
  if (/nginx|502|503|proxy|server config/.test(t)) return 'Fix nginx issue';
  if (/github|ci\b|pipeline|deploy|backend|api|code|bug|fix/.test(t)) return 'Fix technical issue';
  if (/blog|marketing|content|campaign|ad\b|newsletter|seo|social/.test(t)) return 'Generate marketing ideas';
  if (delegated) return 'Handle delegated task';
  return 'Answer user question';
}

function skillStepLabel(skillId) {
  const id = String(skillId || '').trim().toLowerCase();
  if (!id) return 'Processing';
  if (id === 'search') return 'Running search';
  if (id === 'browse') return 'Browsing web';
  if (id === 'memory') return 'Checking memory';
  if (id === 'read' || id === 'go-read') return 'Reading files';
  if (id === 'write' || id === 'go-write' || id === 'edit') return 'Writing changes';
  if (id === 'github') return 'Checking GitHub';
  if (id === 'agent-send') return 'Coordinating team';
  return `Running ${id}`;
}

export function readAllAgentContext() {
  const store = readStore();
  const agents = {};
  for (const [id, row] of Object.entries(store.agents || {})) {
    agents[id] = normalizeAgentRow(id, row);
  }
  return { agents, updatedAt: store.updatedAt || 0 };
}

export function readAgentContext(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return null;
  const store = readStore();
  return normalizeAgentRow(id, store.agents[id] || { state: 'idle' });
}

export function setAgentIdle(agentId) {
  return upsertAgent(agentId, {
    state: 'idle',
    currentStep: '',
    waitingFor: '',
    currentGoal: '',
    context: [],
    knownFacts: [],
  });
}

export function onAgentTurnStart({ agentId, userText, ctx }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const task = summarizeTask(userText, 200);
  const pair = parseInternalPairJid(ctx?.jid);
  const project = extractProjectContext(userText);
  const delegated = !!pair;
  const goal = inferGoal(userText, { delegated });
  const prev = readAgentContext(id) || normalizeAgentRow(id, {});
  let context = prev.context.slice();
  if (delegated && pair.fromAgentId) {
    context = pushUnique(context, `Received task from ${pair.fromAgentId}`);
  } else if (task) {
    context = pushUnique(context, `User asking: ${task}`);
  }
  if (project) context = pushUnique(context, project.replace('Project = ', 'Project: '));
  let knownFacts = prev.knownFacts.slice();
  if (project) knownFacts = pushUnique(knownFacts, project, MAX_FACTS);
  upsertAgent(id, {
    state: 'working',
    currentGoal: goal,
    currentStep: 'Processing request',
    waitingFor: '',
    context,
    knownFacts,
  });
}

export function onAgentSkillStart({ agentId, skillId }) {
  const id = String(agentId || '').trim();
  if (!id) return;
  const prev = readAgentContext(id) || normalizeAgentRow(id, { state: 'working' });
  const label = skillStepLabel(skillId);
  let knownFacts = prev.knownFacts.slice();
  if (skillId === 'search') knownFacts = pushUnique(knownFacts, 'Searching for current information', MAX_FACTS);
  upsertAgent(id, {
    state: 'working',
    currentStep: label,
    knownFacts,
  });
}

export function onAgentTurnDone({ agentId }) {
  setAgentIdle(agentId);
}

export function onAgentWaitingFor({ agentId, targetAgentId, task, targetGoal }) {
  const caller = String(agentId || '').trim();
  const target = String(targetAgentId || '').trim();
  if (!caller || !target) return;
  const prev = readAgentContext(caller) || normalizeAgentRow(caller, {});
  const taskSummary = summarizeTask(task, 100);
  let context = prev.context.slice();
  if (taskSummary) context = pushUnique(context, `Delegated: ${taskSummary}`);
  context = pushUnique(context, `${target} working on task`);
  upsertAgent(caller, {
    state: 'blocked',
    waitingFor: target,
    currentStep: `Waiting for ${target}`,
    context,
  });
  if (targetGoal) {
    upsertAgent(target, {
      state: 'working',
      currentGoal: targetGoal,
      currentStep: 'Starting delegated work',
      waitingFor: '',
    });
  }
}

export function onAgentDelegationDone({ callerAgentId, targetAgentId }) {
  const caller = String(callerAgentId || '').trim();
  const target = String(targetAgentId || '').trim();
  if (target) {
    upsertAgent(target, {
      state: 'idle',
      currentStep: '',
      waitingFor: '',
      currentGoal: '',
    });
  }
  if (caller) {
    const prev = readAgentContext(caller);
    if (prev && prev.state === 'blocked' && prev.waitingFor === target) {
      upsertAgent(caller, {
        state: 'working',
        waitingFor: '',
        currentStep: 'Synthesizing team reply',
      });
    }
  }
}

export function onAgentDelegationError({ callerAgentId, targetAgentId }) {
  const caller = String(callerAgentId || '').trim();
  if (!caller) return;
  upsertAgent(caller, {
    state: 'working',
    waitingFor: '',
    currentStep: 'Handling delegation error',
  });
  if (targetAgentId) setAgentIdle(targetAgentId);
}
