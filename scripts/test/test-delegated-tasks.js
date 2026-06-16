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
    const { createMission, getMission } = await import('../../lib/context/missions.js');
    const {
      createDelegatedTask,
      updateDelegatedTaskProgress,
      recordDelegatedTaskReply,
      completeDelegatedTask,
      failDelegatedTask,
      DELEGATED_TASK_STATUSES,
      listDelegatedTasksForAgent,
      listDelegatedTasksForMission,
      buildDelegatedTasksContextBlock,
      resolveMissionForDelegation,
      shouldPersistDelegatedTask,
    } = await import('../../lib/agent/delegated-tasks.js');
    const { buildMissionTickPrompt } = await import('../../lib/context/missions.js');
    const { onAgentWaitingFor, readAgentContext } = await import('../../lib/agent/agent-context-state.js');

    const mission = createMission({
      title: 'Improve onboarding',
      objective: 'Increase activation rate',
      ownerAgentId: 'main',
      status: 'active',
      tasks: [
        { id: 'research', title: 'Baseline metrics', status: 'doing', progress: 20, assignee: 'main', tasks: [] },
      ],
    });

    const resolved = resolveMissionForDelegation({
      callerAgentId: 'main',
      message: 'Continue improve onboarding research',
    });
    assert(resolved?.id === mission.id, 'resolveMissionForDelegation finds active mission');

    const created = createDelegatedTask({
      missionId: mission.id,
      assignee: 'marketer',
      delegatedFrom: 'main',
      title: 'Competitor signup audit',
      message: 'Review 3 competitor signup flows and list friction points.',
      expectedOutput: '3 examples with 2 friction points each',
      dueInHours: 24,
    });
    assert(created?.task?.source === 'delegation', 'task marked as delegation');
    assert(created.task.assignee === 'marketer', 'assignee set');
    assert(created.task.status === 'assigned', 'starts as assigned');
    assert(created.task.expectedOutput.includes('3 examples'), 'expected output stored');
    assert(DELEGATED_TASK_STATUSES.includes('review_ready'), 'delegated task statuses include review_ready');
    assert(
      shouldPersistDelegatedTask({
        title: 'Competitor signup audit',
        message: 'Review 3 competitor signup flows and list friction points.',
        expectedOutput: '3 examples with 2 friction points each',
      }),
      'concrete delegated work should persist',
    );
    assert(
      !shouldPersistDelegatedTask({
        title: 'Increase customer sign-ups for NextpostAI',
        message: 'How many tasks or todos are there with agents?',
        expectedOutput: 'How many tasks or todos are there with agents?',
      }),
      'tracker status questions should not persist as delegated tasks',
    );

    const missionAfterAssign = getMission(mission.id);
    const flat = JSON.stringify(missionAfterAssign.tasks);
    assert(flat.includes('Competitor signup audit'), 'task persisted on mission');

    const forMarketer = listDelegatedTasksForAgent('marketer');
    assert(forMarketer.length === 1, 'marketer has one delegated task');
    assert(forMarketer[0].taskId === created.task.id, 'listed task id matches');

    const forMission = listDelegatedTasksForMission(mission.id);
    assert(forMission.length === 1, 'mission lists delegated task');

    const block = buildDelegatedTasksContextBlock('marketer');
    assert(/Assigned delegated tasks/.test(block), 'context block generated');
    assert(/Expected output/.test(block), 'context block includes expected output');

    onAgentWaitingFor({
      agentId: 'main',
      targetAgentId: 'marketer',
      task: 'Review 3 competitor signup flows',
      delegatedTask: {
        missionId: mission.id,
        missionTitle: mission.title,
        taskId: created.task.id,
        expectedOutput: created.task.expectedOutput,
        dueAt: created.task.dueAt,
      },
    });
    const marketerCtx = readAgentContext('marketer');
    assert(marketerCtx.currentMission === mission.title, 'target agent mission from mission');
    assert(marketerCtx.context.some((c) => c.includes('Expected')), 'target agent has expected output context');

    recordDelegatedTaskReply({
      missionId: mission.id,
      taskId: created.task.id,
      expectedOutput: created.task.expectedOutput,
    }, {
      replySummary: [
        'Delivered the final competitor signup audit.',
        '1. Competitor A: requires company name and phone; friction points are long form and no social login.',
        '2. Competitor B: hides pricing and asks for card; friction points are unclear value and payment wall.',
        '3. Competitor C: asks for role before showing product; friction points are delayed value and survey fatigue.',
      ].join('\n'),
    });
    const reviewMission = getMission(mission.id);
    const reviewSg = (reviewMission.tasks || []).find((sg) => sg.id === created.task.id);
    assert(reviewSg?.status === 'review_ready', 'satisfying reply marks task review_ready');
    assert(reviewSg?.progress === 90, 'review-ready progress set below done');

    completeDelegatedTask({
      missionId: mission.id,
      taskId: created.task.id,
    }, { replySummary: 'Accepted by lead after review.' });
    const doneMission = getMission(mission.id);
    const doneSg = (doneMission.tasks || []).find((sg) => sg.id === created.task.id);
    assert(doneSg?.status === 'done', 'explicit completion marks task done');
    assert(doneSg?.progress === 100, 'explicit completion sets progress to 100');

    const vague = createDelegatedTask({
      missionId: mission.id,
      assignee: 'marketer',
      delegatedFrom: 'main',
      title: 'Launch plan',
      message: 'Create launch plan',
      expectedOutput: 'launch checklist with channels dates owners and risks',
      dueInHours: 24,
    });
    recordDelegatedTaskReply({
      missionId: mission.id,
      taskId: vague.task.id,
      expectedOutput: vague.task.expectedOutput,
    }, { replySummary: 'We should make the launch feel exciting and focus on the right audience.' });
    const vagueMission = getMission(mission.id);
    const vagueSg = (vagueMission.tasks || []).find((sg) => sg.id === vague.task.id);
    assert(vagueSg?.status === 'in_progress', 'vague specialist reply remains in_progress');
    assert(vagueSg?.status !== 'done', 'vague specialist reply is not auto-completed');

    const blocked = createDelegatedTask({
      missionId: mission.id,
      assignee: 'alex',
      delegatedFrom: 'main',
      title: 'CI failure triage',
      message: 'Investigate CI failures',
      dueInHours: 12,
    });
    failDelegatedTask({
      missionId: mission.id,
      taskId: blocked.task.id,
    }, 'Agent timeout');
    const blockedMission = getMission(mission.id);
    const blockedSg = (blockedMission.tasks || []).find((sg) => sg.id === blocked.task.id);
    assert(blockedSg?.status === 'blocked', 'failed delegation marks task blocked');

    updateDelegatedTaskProgress({
      missionId: mission.id,
      taskId: blocked.task.id,
      status: 'in_progress',
      progress: 30,
    });
    const reopened = getMission(mission.id);
    const reopenedSg = (reopened.tasks || []).find((sg) => sg.id === blocked.task.id);
    assert(reopenedSg?.status === 'in_progress', 'progress update patches status');
    assert(reopenedSg?.progress === 30, 'progress update patches pct');

    const tickPrompt = buildMissionTickPrompt(getMission(mission.id), {
      memoryPath: '/tmp/mission-memory.md',
      missionMemory: '',
    });
    assert(/Open delegated assignments/.test(tickPrompt), 'mission tick prompt lists delegated work');
    assert(/agent-send creates persistent delegated tasks/.test(tickPrompt), 'mission tick prompt explains structured delegation');
    assert(/taskTitle/.test(tickPrompt), 'mission tick schema includes delegation fields');

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
