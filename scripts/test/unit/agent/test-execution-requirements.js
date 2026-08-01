#!/usr/bin/env node

import {
  advanceExecutionProgress,
  buildExecutionRequirements,
  getRemainingToolSteps,
  normalizeRequiredToolSteps,
} from '../../../../lib/agent/execution-requirements.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const explicit = buildExecutionRequirements({
  mode: 'code',
  skills: ['go-read', 'write', 'exec'],
  mustUseTool: true,
  requiredToolSteps: [
    {
      kind: 'write',
      anyOfSkills: ['write', 'not-exposed'],
      anyOfTools: ['write_file', 'not_exposed_file'],
      requiredArguments: { path: 'runtime-probe.js' },
    },
    {
      kind: 'execute',
      anyOfSkills: ['exec'],
      anyOfTools: ['exec_run'],
      requiredArguments: { command: 'node', argv: ['runtime-probe.js'] },
      resultContains: 'PASTURE_RESULT:',
    },
  ],
});

assert(explicit.source === 'planner', 'explicit requirements keep planner source');
assert(explicit.usesExtendedBudget === true, 'write/execute contract selects extended budget');
assert(explicit.steps[0].anyOfSkills.join(',') === 'write', 'unexposed alternatives are filtered');

let progress = 0;
progress = advanceExecutionProgress(explicit, progress, { skillId: 'go-read', toolName: 'go_read_run' }, true);
assert(progress === 0, 'a successful read does not satisfy write');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'exec',
  toolName: 'exec_run',
  arguments: { command: 'node', argv: ['runtime-probe.js'] },
  result: 'PASTURE_RESULT:42',
}, true);
assert(progress === 0, 'an early successful exec does not satisfy write or a later execute step');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'write', toolName: 'write_file', arguments: { path: 'runtime-probe.js' },
}, false);
assert(progress === 0, 'a failed write does not advance');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'write', toolName: 'write_file', arguments: { path: 'unrelated.js' },
}, true);
assert(progress === 0, 'the correct write tool on the wrong target does not advance');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'write', toolName: 'write_file', arguments: { path: 'runtime-probe.js' },
}, true);
assert(progress === 1, 'a successful write advances exactly one step');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'exec',
  toolName: 'exec_run',
  arguments: { command: 'node', argv: ['runtime-probe.js'] },
}, false);
assert(progress === 1, 'a failed exec does not advance execute');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'exec',
  toolName: 'exec_run',
  arguments: { command: 'node', argv: ['--version'] },
  result: 'v22.0.0',
}, true);
assert(progress === 1, 'the correct exec tool with the wrong command arguments does not advance');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'exec',
  toolName: 'exec_run',
  arguments: { command: 'node', argv: ['runtime-probe.js'] },
  result: 'unrelated output',
}, true);
assert(progress === 1, 'matching execution without planned output evidence does not advance');
progress = advanceExecutionProgress(explicit, progress, {
  skillId: 'exec',
  toolName: 'exec_run',
  arguments: { command: 'node', argv: ['runtime-probe.js'] },
  result: 'PASTURE_RESULT:42',
}, true);
assert(progress === 2, 'a successful exec completes execute');
assert(getRemainingToolSteps(explicit, progress).length === 0, 'no steps remain after ordered success');

const fallback = buildExecutionRequirements({
  mode: 'code',
  skills: ['write', 'exec'],
  mustUseTool: true,
});
assert(fallback.steps.length === 1 && fallback.steps[0].kind === 'inspect',
  'legacy mandatory code routes require one generic tool success');
assert(fallback.steps[0].anyOfSkills.join(',') === 'write,exec',
  'fallback keeps the planned profile without inferring mutation steps');
assert(!fallback.steps.some((step) => step.kind === 'write' || step.kind === 'execute'),
  'capability exposure alone never forces write or execute');

const generic = buildExecutionRequirements({
  mode: 'tool',
  skills: ['search', 'go-read'],
  mustUseTool: true,
});
assert(generic.steps.length === 1 && generic.steps[0].kind === 'inspect',
  'legacy mandatory tool routes require one planned success');

const filtered = normalizeRequiredToolSteps([
  { kind: 'execute', anyOfSkills: ['exec', 'missing'], anyOfTools: ['exec_node_script', 'exec_bogus', 'missing_action'] },
  { kind: 'unknown', anyOfSkills: ['exec'] },
], ['exec']);
assert(filtered.length === 1 && filtered[0].anyOfSkills.join(',') === 'exec',
  'normalization filters invalid kinds and unavailable skills');
assert(filtered[0].anyOfTools.join(',') === 'exec_node_script',
  'normalization filters hallucinated and unavailable exact tool names');

console.log('execution-requirements tests passed');
