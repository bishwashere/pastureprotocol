#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-delegated-tasks-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { createGoal, getGoal } = await import('../../lib/goals.js');
    const {
      createDelegatedSubgoal,
      updateDelegatedSubgoalProgress,
      completeDelegatedSubgoal,
      failDelegatedSubgoal,
      listDelegatedSubgoalsForAgent,
      listDelegatedSubgoalsForGoal,
      buildDelegatedTasksContextBlock,
      resolveGoalForDelegation,
    } = await import('../../lib/delegated-tasks.js');
    const { buildGoalTickPrompt } = await import('../../lib/goals.js');
    const { onAgentWaitingFor, readAgentContext } = await import('../../lib/agent-context-state.js');

    const mission = createGoal({
      title: 'Improve onboarding',
      objective: 'Increase activation rate',
      ownerAgentId: 'main',
      status: 'active',
      subgoals: [
        { id: 'research', title: 'Baseline metrics', status: 'doing', progress: 20, assignee: 'main', subgoals: [] },
      ],
    });

    const resolved = resolveGoalForDelegation({
      callerAgentId: 'main',
      message: 'Continue improve onboarding research',
    });
    assert(resolved?.id === mission.id, 'resolveGoalForDelegation finds active goal');

    const created = createDelegatedSubgoal({
      goalId: mission.id,
      assignee: 'marketer',
      delegatedFrom: 'main',
      title: 'Competitor signup audit',
      message: 'Review 3 competitor signup flows and list friction points.',
      expectedOutput: '3 examples with 2 friction points each',
      dueInHours: 24,
    });
    assert(created?.subgoal?.source === 'delegation', 'subgoal marked as delegation');
    assert(created.subgoal.assignee === 'marketer', 'assignee set');
    assert(created.subgoal.status === 'doing', 'starts as doing');
    assert(created.subgoal.expectedOutput.includes('3 examples'), 'expected output stored');

    const goalAfterAssign = getGoal(mission.id);
    const flat = JSON.stringify(goalAfterAssign.subgoals);
    assert(flat.includes('Competitor signup audit'), 'subgoal persisted on goal');

    const forMarketer = listDelegatedSubgoalsForAgent('marketer');
    assert(forMarketer.length === 1, 'marketer has one delegated task');
    assert(forMarketer[0].subgoalId === created.subgoal.id, 'listed subgoal id matches');

    const forGoal = listDelegatedSubgoalsForGoal(mission.id);
    assert(forGoal.length === 1, 'goal lists delegated subgoal');

    const block = buildDelegatedTasksContextBlock('marketer');
    assert(/Assigned delegated tasks/.test(block), 'context block generated');
    assert(/Expected output/.test(block), 'context block includes expected output');

    onAgentWaitingFor({
      agentId: 'main',
      targetAgentId: 'marketer',
      task: 'Review 3 competitor signup flows',
      delegatedTask: {
        goalId: mission.id,
        goalTitle: mission.title,
        subgoalId: created.subgoal.id,
        expectedOutput: created.subgoal.expectedOutput,
        dueAt: created.subgoal.dueAt,
      },
    });
    const marketerCtx = readAgentContext('marketer');
    assert(marketerCtx.currentGoal === mission.title, 'target agent goal from mission');
    assert(marketerCtx.context.some((c) => c.includes('Expected')), 'target agent has expected output context');

    completeDelegatedSubgoal({
      goalId: mission.id,
      subgoalId: created.subgoal.id,
    }, { replySummary: 'Delivered 3 competitor examples' });
    const doneGoal = getGoal(mission.id);
    const doneSg = (doneGoal.subgoals || []).find((sg) => sg.id === created.subgoal.id);
    assert(doneSg?.status === 'done', 'subgoal marked done after completion');
    assert(doneSg?.progress === 100, 'progress set to 100');

    const blocked = createDelegatedSubgoal({
      goalId: mission.id,
      assignee: 'alex',
      delegatedFrom: 'main',
      title: 'CI failure triage',
      message: 'Investigate CI failures',
      dueInHours: 12,
    });
    failDelegatedSubgoal({
      goalId: mission.id,
      subgoalId: blocked.subgoal.id,
    }, 'Agent timeout');
    const blockedGoal = getGoal(mission.id);
    const blockedSg = (blockedGoal.subgoals || []).find((sg) => sg.id === blocked.subgoal.id);
    assert(blockedSg?.status === 'blocked', 'failed delegation marks subgoal blocked');

    updateDelegatedSubgoalProgress({
      goalId: mission.id,
      subgoalId: blocked.subgoal.id,
      status: 'doing',
      progress: 30,
    });
    const reopened = getGoal(mission.id);
    const reopenedSg = (reopened.subgoals || []).find((sg) => sg.id === blocked.subgoal.id);
    assert(reopenedSg?.status === 'doing', 'progress update patches status');
    assert(reopenedSg?.progress === 30, 'progress update patches pct');

    const tickPrompt = buildGoalTickPrompt(getGoal(mission.id), {
      memoryPath: '/tmp/goal-memory.md',
      goalMemory: '',
    });
    assert(/Open delegated assignments/.test(tickPrompt), 'goal tick prompt lists delegated work');
    assert(/agent-send creates persistent delegated subgoals/.test(tickPrompt), 'goal tick prompt explains structured delegation');
    assert(/taskTitle/.test(tickPrompt), 'goal tick schema includes delegation fields');

    console.log('test-delegated-tasks: all assertions passed');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.COWCODE_STATE_DIR;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
