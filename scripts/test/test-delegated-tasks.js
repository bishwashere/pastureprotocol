#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-delegated-tasks-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createGoal, getGoal } = await import('../../lib/goals.js');
    const {
      createDelegatedSubgoal,
      updateDelegatedSubgoalProgress,
      recordDelegatedSubgoalReply,
      completeDelegatedSubgoal,
      failDelegatedSubgoal,
      DELEGATED_TASK_STATUSES,
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
    assert(created.subgoal.status === 'assigned', 'starts as assigned');
    assert(created.subgoal.expectedOutput.includes('3 examples'), 'expected output stored');
    assert(DELEGATED_TASK_STATUSES.includes('review_ready'), 'delegated task statuses include review_ready');

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

    recordDelegatedSubgoalReply({
      goalId: mission.id,
      subgoalId: created.subgoal.id,
      expectedOutput: created.subgoal.expectedOutput,
    }, {
      replySummary: [
        'Delivered the final competitor signup audit.',
        '1. Competitor A: requires company name and phone; friction points are long form and no social login.',
        '2. Competitor B: hides pricing and asks for card; friction points are unclear value and payment wall.',
        '3. Competitor C: asks for role before showing product; friction points are delayed value and survey fatigue.',
      ].join('\n'),
    });
    const reviewGoal = getGoal(mission.id);
    const reviewSg = (reviewGoal.subgoals || []).find((sg) => sg.id === created.subgoal.id);
    assert(reviewSg?.status === 'review_ready', 'satisfying reply marks subgoal review_ready');
    assert(reviewSg?.progress === 90, 'review-ready progress set below done');

    completeDelegatedSubgoal({
      goalId: mission.id,
      subgoalId: created.subgoal.id,
    }, { replySummary: 'Accepted by lead after review.' });
    const doneGoal = getGoal(mission.id);
    const doneSg = (doneGoal.subgoals || []).find((sg) => sg.id === created.subgoal.id);
    assert(doneSg?.status === 'done', 'explicit completion marks subgoal done');
    assert(doneSg?.progress === 100, 'explicit completion sets progress to 100');

    const vague = createDelegatedSubgoal({
      goalId: mission.id,
      assignee: 'marketer',
      delegatedFrom: 'main',
      title: 'Launch plan',
      message: 'Create launch plan',
      expectedOutput: 'launch checklist with channels dates owners and risks',
      dueInHours: 24,
    });
    recordDelegatedSubgoalReply({
      goalId: mission.id,
      subgoalId: vague.subgoal.id,
      expectedOutput: vague.subgoal.expectedOutput,
    }, { replySummary: 'We should make the launch feel exciting and focus on the right audience.' });
    const vagueGoal = getGoal(mission.id);
    const vagueSg = (vagueGoal.subgoals || []).find((sg) => sg.id === vague.subgoal.id);
    assert(vagueSg?.status === 'in_progress', 'vague specialist reply remains in_progress');
    assert(vagueSg?.status !== 'done', 'vague specialist reply is not auto-completed');

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
      status: 'in_progress',
      progress: 30,
    });
    const reopened = getGoal(mission.id);
    const reopenedSg = (reopened.subgoals || []).find((sg) => sg.id === blocked.subgoal.id);
    assert(reopenedSg?.status === 'in_progress', 'progress update patches status');
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
    delete process.env.PASTURE_STATE_DIR;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
