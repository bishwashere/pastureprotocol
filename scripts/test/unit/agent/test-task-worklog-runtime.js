#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');
const requirements = readFileSync(join(root, 'lib/agent/execution-requirements.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(agent.includes("templates', 'task-worklog-policy.md"),
  'shared runAgentTurn loads the Markdown worklog policy');
assert(/let worklogRequired = executionRequirements\?\.worklogRequired === true/.test(agent),
  'runtime activation comes from the planner contract');
assert(/ensureTaskWorklog\(worklogCtx/.test(agent),
  'runtime creates a per-run durable worklog');
assert(/recordWorklogToolOutcome\(\{[\s\S]{0,180}?skillId,[\s\S]{0,180}?result/.test(agent),
  'main tool loop records each tool outcome');
assert(/await checkpointPendingToolBatch\(\);[\s\S]{0,700}?enforceMessagesBudget/.test(agent),
  'main loop checkpoints before raw messages can be truncated');
assert(/worklogContextMessage = \{ role: 'user', content \}/.test(agent),
  'latest worklog is pinned as explicitly untrusted user-level data');
assert(!/messages\[0\][\s\S]{0,120}?formatTaskWorklogPromptBlock/.test(agent),
  'dynamic checkpoint text is not promoted into the system message');
assert(/TASK_WORKLOG_RECOVERY/.test(agent) && /worklogReadCheckpointCount/.test(agent),
  'runtime asks the model to read checkpoints before final synthesis');
assert(/finalizeTaskWorklog\(worklogCtx/.test(agent),
  'runtime finalizes worklogs on completion/error');
assert(/toolRoundLimit = worklogRequired[\s\S]{0,120}?MAX_TOOL_ROUNDS_WORKLOG/.test(agent),
  'checkpoint-enabled read-only work receives extended rounds');
assert(/\|\| worklogRequired/.test(requirements),
  'execution requirement contract selects extended budget for checkpoint mode');
assert(/MAX_TOOL_ROUNDS_WORKLOG/.test(agent),
  'long checkpointed runs have a dedicated budget beyond the write cap');
assert(/worklogCheckpointRetryCount/.test(agent) && /pendingWorklogToolResults = \[\.\.\.batch/.test(agent),
  'one transient checkpoint failure retains its tool batch for retry');
assert(/round \+ 2 >= toolRoundLimit[\s\S]{0,80}?toolRoundLimit = round \+ 3/.test(agent),
  'runtime reserves final read and synthesis rounds near the long-run cap');
assert(/skillId === 'worklog' && action === 'checkpoint'[\s\S]{0,500}?MAX_TOOL_ROUNDS_WORKLOG/.test(agent),
  'an agent-initiated checkpoint can promote an ordinary turn to long-run mode');

console.log('task-worklog runtime tests passed');
