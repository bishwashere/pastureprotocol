/**
 * Mechanical enforcement contract derived from an LLM-produced turn route.
 *
 * The planner decides which tool steps are required. This module only
 * validates that structured output and advances an ordered success ledger.
 */

const VALID_STEP_KINDS = new Set(['inspect', 'write', 'execute', 'verify', 'delegate']);
const WRITE_SKILL_IDS = new Set(['write', 'edit', 'apply-patch', 'go-write']);

const DEFAULT_TOOLS_BY_STEP = Object.freeze({
  inspect: Object.freeze({
    read: ['read_file'],
    'go-read': ['go_read_run', 'go_read_dashboard_url'],
  }),
  write: Object.freeze({
    write: ['write_file'],
    edit: ['edit_file'],
    'apply-patch': ['apply_patch_apply'],
    'go-write': ['go_write_run', 'go_write_create_next_app'],
  }),
  execute: Object.freeze({
    exec: ['exec_run', 'exec_node_script'],
    'go-read': ['go_read_run'],
  }),
  verify: Object.freeze({
    read: ['read_file'],
    'go-read': ['go_read_run', 'go_read_dashboard_url'],
  }),
  delegate: Object.freeze({
    'agent-send': ['agent_send_send'],
  }),
});

const KNOWN_TOOLS_BY_SKILL = Object.freeze(
  Object.values(DEFAULT_TOOLS_BY_STEP).reduce((out, bySkill) => {
    for (const [skillId, names] of Object.entries(bySkill)) {
      out[skillId] = [...new Set([...(out[skillId] || []), ...names])];
    }
    return out;
  }, {}),
);

function uniqueSkillIds(values, allowed = null, max = 8) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const id = String(raw || '').trim();
    if (!id || (allowed && !allowed.has(id)) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function uniqueToolNames(values, skillIds, max = 12) {
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const name = String(raw || '').trim();
    const belongsToSkill = name === 'run_skill' || (skillIds || []).some((skillId) => {
      const knownNames = KNOWN_TOOLS_BY_SKILL[skillId];
      if (knownNames) return knownNames.includes(name);
      return name.startsWith(`${skillId.replace(/-/g, '_')}_`);
    });
    if (!name || !belongsToSkill || out.includes(name)) continue;
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeConstraintValue(value) {
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => String(item).slice(0, 500));
  }
  return undefined;
}

function normalizeRequiredArguments(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = String(rawKey || '').trim();
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    const value = normalizeConstraintValue(rawValue);
    if (value === undefined) continue;
    out[key.slice(0, 80)] = value;
    if (Object.keys(out).length >= 8) break;
  }
  return out;
}

function constraintValuesEqual(actual, expected) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => String(actual[index]) === value);
  }
  return actual === expected;
}

function defaultToolNames(kind, skillIds) {
  const bySkill = DEFAULT_TOOLS_BY_STEP[kind] || {};
  return uniqueToolNames(
    (skillIds || []).flatMap((skillId) => bySkill[skillId] || []),
    skillIds,
  );
}

/**
 * Validate planner-produced ordered steps against skills available to the
 * current route. Invalid or unenforceable steps are discarded.
 */
export function normalizeRequiredToolSteps(rawSteps, availableSkillIds = null) {
  const hasAllowlist = Array.isArray(availableSkillIds);
  const allowedIds = uniqueSkillIds(availableSkillIds, null, 40);
  const allowed = new Set(allowedIds);
  const steps = [];
  for (const raw of Array.isArray(rawSteps) ? rawSteps : []) {
    if (!raw || typeof raw !== 'object' || !VALID_STEP_KINDS.has(raw.kind)) continue;
    const anyOfSkills = uniqueSkillIds(
      raw.anyOfSkills,
      hasAllowlist ? allowed : null,
      8,
    );
    if (anyOfSkills.length === 0) continue;
    const requestedTools = uniqueToolNames(raw.anyOfTools, anyOfSkills);
    const anyOfTools = requestedTools.length > 0
      ? requestedTools
      : defaultToolNames(raw.kind, anyOfSkills);
    const requiredArguments = normalizeRequiredArguments(raw.requiredArguments);
    const resultContains = typeof raw.resultContains === 'string'
      ? raw.resultContains.trim().slice(0, 500)
      : '';
    steps.push({ kind: raw.kind, anyOfSkills, anyOfTools, requiredArguments, resultContains });
    if (steps.length >= 6) break;
  }
  return steps;
}

/**
 * Build the runtime contract from a structured route. Older route producers
 * that do not yet emit requiredToolSteps retain a conservative fallback:
 * mandatory routes require one successful planned skill. Outcome-specific
 * write/execute ordering must come from the current-turn planner; it is never
 * inferred from capabilities that merely happen to be exposed.
 */
export function buildExecutionRequirements(turnRoute) {
  const route = turnRoute && typeof turnRoute === 'object' ? turnRoute : {};
  const plannedSkills = uniqueSkillIds(route.skills, null, 40);
  let steps = normalizeRequiredToolSteps(route.requiredToolSteps, plannedSkills);
  const source = steps.length > 0 ? 'planner' : 'fallback';

  if (steps.length === 0 && route.mustUseTool === true && plannedSkills.length > 0) {
    steps.push({
      kind: 'inspect',
      anyOfSkills: plannedSkills,
      anyOfTools: [],
      requiredArguments: {},
      resultContains: '',
    });
  }

  const usesExtendedBudget = steps.some((step) => step.kind === 'write' || step.kind === 'execute')
    || (route.mode === 'code' && plannedSkills.some((id) => WRITE_SKILL_IDS.has(id) || id === 'exec'));

  return {
    steps,
    source,
    usesExtendedBudget,
  };
}

/** One successful tool call can satisfy at most one ordered step. */
export function toolCallMatchesRequiredStep(step, toolCall, { checkResult = true } = {}) {
  if (!step || !toolCall) return false;
  const skillId = String(toolCall.skillId || '').trim();
  const toolName = String(toolCall.toolName || '').trim();
  if (!step.anyOfSkills.includes(skillId)) return false;
  const toolMatches = !Array.isArray(step.anyOfTools)
    || step.anyOfTools.length === 0
    || step.anyOfTools.includes(toolName);
  if (!toolMatches) return false;
  const args = toolCall.arguments && typeof toolCall.arguments === 'object'
    ? toolCall.arguments
    : {};
  for (const [name, expected] of Object.entries(step.requiredArguments || {})) {
    if (!constraintValuesEqual(args[name], expected)) return false;
  }
  if (checkResult && step.resultContains) {
    return String(toolCall.result || '').includes(step.resultContains);
  }
  return true;
}

export function advanceExecutionProgress(requirements, progressIndex, toolCall, succeeded) {
  const steps = Array.isArray(requirements?.steps) ? requirements.steps : [];
  const current = Math.max(0, Number.isFinite(progressIndex) ? Math.floor(progressIndex) : 0);
  if (!succeeded || current >= steps.length) return current;
  return toolCallMatchesRequiredStep(steps[current], toolCall) ? current + 1 : current;
}

export function getRemainingToolSteps(requirements, progressIndex) {
  const steps = Array.isArray(requirements?.steps) ? requirements.steps : [];
  const current = Math.max(0, Number.isFinite(progressIndex) ? Math.floor(progressIndex) : 0);
  return steps.slice(current).map((step) => ({
    kind: step.kind,
    anyOfSkills: [...step.anyOfSkills],
    anyOfTools: [...(step.anyOfTools || [])],
    requiredArguments: { ...(step.requiredArguments || {}) },
    resultContains: step.resultContains || '',
  }));
}

export function formatRequiredToolStep(step) {
  if (!step) return '';
  const tools = Array.isArray(step.anyOfTools) && step.anyOfTools.length
    ? ` via [${step.anyOfTools.join(' | ')}]`
    : '';
  const requiredArguments = step.requiredArguments && Object.keys(step.requiredArguments).length
    ? ` args=${JSON.stringify(step.requiredArguments)}`
    : '';
  const resultEvidence = step.resultContains
    ? ` output includes ${JSON.stringify(step.resultContains)}`
    : '';
  return `${step.kind} [${(step.anyOfSkills || []).join(' | ')}]${tools}${requiredArguments}${resultEvidence}`;
}

export const REQUIRED_TOOL_STEP_KINDS = Object.freeze([...VALID_STEP_KINDS]);
