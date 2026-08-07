#!/usr/bin/env node

import { routeTurn, turnRouteToSystemBlock } from '../../../../lib/agent/turn-router.js';
import { buildExecutionRequirements } from '../../../../lib/agent/execution-requirements.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const route = await routeTurn({
  userText: 'Create and run a small JavaScript diagnostic.',
  availableSkillIds: ['go-read', 'write', 'exec', 'worklog'],
  availableSkillSummaries: [
    { id: 'go-read', description: 'read files' },
    { id: 'write', description: 'write files' },
    { id: 'exec', description: 'execute commands and transient scripts' },
    { id: 'worklog', description: 'checkpoint long task results' },
  ],
  llmChat: async () => JSON.stringify({
    mode: 'code',
    needsWorklog: true,
    skills: ['go-read'],
    requiredToolSteps: [
      {
        kind: 'write',
        anyOfSkills: ['write'],
        anyOfTools: ['write_file'],
        requiredArguments: { path: 'probe.mjs' },
      },
      {
        kind: 'execute',
        anyOfSkills: ['exec'],
        anyOfTools: ['exec_node_script'],
        requiredArguments: { envFile: '.env' },
        resultContains: 'PASTURE_DB_COUNT:',
      },
    ],
    mustUseTool: false,
    executionMode: 'tool_use',
    usesExistingWorkIntake: false,
    plan: 'Write, execute, and report real output.',
    answer_style: 'short',
  }),
});

assert(route.mode === 'code', 'legacy route keeps code mode');
assert(route.needsWorklog === true && route.skills.includes('worklog'),
  'legacy route preserves planner-selected checkpoint mode');
assert(route.skills.includes('write') && route.skills.includes('exec'),
  'required step skills are added to exposed route skills');
assert(route.mustUseTool === true, 'required steps force tool use');
assert(route.requiredToolSteps.map((step) => step.kind).join(',') === 'write,execute',
  'legacy route preserves ordered required steps');
assert(turnRouteToSystemBlock(route).includes('write [write] via [write_file] args={"path":"probe.mjs"} -> execute [exec] via [exec_node_script] args={"envFile":".env"} output includes "PASTURE_DB_COUNT:"'),
  'system block renders the ordered contract');

const requirements = buildExecutionRequirements(route);
assert(requirements.steps.length === 2 && requirements.usesExtendedBudget,
  'legacy route builds an enforceable extended-budget contract');
assert(requirements.worklogRequired === true,
  'legacy route carries checkpoint enforcement to runAgentTurn');

console.log('turn-router required-step tests passed');
