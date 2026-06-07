#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-missions-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      listMissions,
      getMission,
      createMission,
      updateMission,
      listDueMissions,
      processDueMissionsInStore,
      runMissionTick,
      buildMissionTickPrompt,
      getMissionMemoryPath,
      readMissionMemory,
      respondToMissionUserInput,
      partitionTasksByWait,
      taskBlockedByWait,
      normalizeWaitAppliesTo,
    } = await import('../../lib/missions.js');
    const { logTeamActivity } = await import('../../lib/team-activity.js');

    const created = createMission({
      title: 'Ship missions feature',
      objective: 'Implement persistent missions with autonomous ticks',
      ownerAgentId: 'main',
      intervalMs: 30_000,
      tasks: [
        { id: 'research', title: 'Research', status: 'doing', progress: 40, assignee: 'marketer', dependsOn: [] },
      ],
    });
    assert(created.id && created.status === 'active', 'mission created as active');
    assert(Array.isArray(created.tasks) && created.tasks.length === 1, 'initial tasks normalized');
    assert(Array.isArray(listMissions().missions) && listMissions().missions.length === 1, 'mission persisted');

    const prompt = buildMissionTickPrompt(created);
    assert(/Mission ID/.test(prompt) && /STRICT JSON/.test(prompt), 'mission tick prompt generated');
    assert(/1\) Review/.test(prompt), 'prompt includes review section');
    assert(/2\) Progress Evaluation/.test(prompt), 'prompt includes progress evaluation section');
    assert(/3\) Next Action Selection/.test(prompt), 'prompt includes next action selection section');
    assert(/4\) Delegation Check/.test(prompt), 'prompt includes delegation check section');
    assert(/5\) Reflection & Memory Update/.test(prompt), 'prompt includes reflection section');
    assert(/6\) User Input Check/.test(prompt), 'prompt includes user input check section');
    assert(/7\) Waiting \/ Watchers \/ Conditions/.test(prompt), 'prompt includes waiting section');
    assert(/8\) Opportunity Detection/.test(prompt), 'prompt includes opportunity detection section');
    assert(/"userInputRequired": false/.test(prompt), 'prompt includes user input required flag');
    assert(/partial wait does NOT pause mission ticks/.test(prompt), 'prompt explains partial wait keeps ticking');
    assert(/waitAppliesTo/.test(prompt), 'prompt includes waitAppliesTo');
    const partialPrompt = buildMissionTickPrompt({
      ...created,
      waitCondition: {
        kind: 'partial',
        waitAppliesTo: 'implementation',
        reason: 'Await analytics vendor',
      },
      tasks: [
        { id: 'research-competitors', title: 'Competitor signup research', status: 'todo', progress: 0, tasks: [] },
        { id: 'instrument-funnel', title: 'Instrument funnel with PostHog', status: 'doing', progress: 10, tasks: [] },
      ],
    });
    assert(/Actionable branches/.test(partialPrompt), 'prompt lists actionable branches during wait');
    assert(/Blocked branches/.test(partialPrompt), 'prompt lists blocked branches during wait');
    assert(/"wait":/.test(prompt), 'prompt includes wait schema');
    assert(/partial/.test(prompt), 'prompt includes partial wait kind');
    assert(/9\) Curiosity & Next Steps/.test(prompt), 'prompt includes curiosity section');
    assert(/createdTasks/.test(prompt), 'prompt includes createdTasks schema');
    assert(/"suggestedTasks": \[\{/.test(prompt), 'prompt includes suggestedTasks schema');
    const memoryPath = getMissionMemoryPath(created.id);
    assert(existsSync(memoryPath), 'mission memory file created');
    assert(/Per-mission memory file path/.test(prompt), 'prompt includes memory path');

    updateMission(created.id, { nextRunAt: Date.now() - 1 });
    assert(listDueMissions().length === 1, 'mission is due');

    const runResult = await runMissionTick(created.id, {
      runMissionTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Gathered evidence and updated plan.',
          progressPct: 42,
          evidence: ['checked team activity', 'drafted missions UI'],
          currentStep: 'Building dashboard tab',
          nextRunInSec: 45,
          contextSnapshot: 'UI and API partially implemented',
          memoryAnchors: ['mission=ship-missions', 'phase=ui'],
          learnings: ['Scoring should happen before planning'],
          decisions: ['Keep Team tab as default agent space'],
          userPreferences: ['Prefer concise status cards'],
          failedAttempts: ['Initial missions card had no owner badge'],
          planSteps: [
            { title: 'Implement store', status: 'done' },
            { title: 'Implement UI', status: 'doing' },
          ],
          tasks: [
            {
              id: 'research',
              title: 'Research',
              status: 'done',
              progress: 100,
              assignee: 'marketer',
              dependsOn: [],
              tasks: [],
            },
            {
              id: 'calendar',
              title: 'Content Calendar',
              status: 'doing',
              progress: 35,
              assignee: 'main',
              dependsOn: ['research'],
              tasks: [
                {
                  id: 'production',
                  title: 'Production',
                  status: 'todo',
                  progress: 0,
                  assignee: 'main',
                  dependsOn: ['calendar'],
                  tasks: [
                    {
                      id: 'promotion',
                      title: 'Promotion',
                      status: 'todo',
                      progress: 0,
                      assignee: 'marketer',
                      dependsOn: ['production'],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        skillsCalled: ['read', 'write'],
      }),
    });
    assert(runResult.mission.progress.pct === 42, `progress expected 42, got ${runResult.mission.progress.pct}`);
    assert(runResult.mission.lastActivity.includes('Gathered evidence'), 'summary persisted');
    assert(runResult.mission.running === false, 'mission not left running');
    assert(Array.isArray(runResult.mission.tasks) && runResult.mission.tasks.length === 2, 'mission task tree saved');
    assert(runResult.mission.tasks[1].dependsOn.includes('research'), 'task dependency saved');
    assert(runResult.mission.tasks[1].tasks[0].tasks[0].title === 'Promotion', 'nested task saved');
    assert(Array.isArray(runResult.createdTasks) && runResult.createdTasks.length === 0, 'no createdTasks when field omitted');

    updateMission(created.id, { nextRunAt: Date.now() - 1, status: 'active' });
    const spawnResult = await runMissionTick(created.id, {
      runMissionTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Discovered follow-up research tasks.',
          progressPct: 45,
          tasks: [
            {
              id: 'research',
              title: 'Research',
              status: 'done',
              progress: 100,
              assignee: 'marketer',
              dependsOn: [],
              tasks: [],
            },
          ],
          createdTasks: [
            {
              title: 'Interview 3 churned users',
              description: 'Capture signup drop-off reasons',
              assignee: 'marketer',
              priority: 2,
              dueInHours: 48,
            },
            {
              title: 'Map onboarding email sequence',
              description: 'Document current lifecycle emails',
              assignee: 'main',
              priority: 3,
              dueInHours: 72,
            },
            {
              title: 'Interview 3 churned users',
              description: 'duplicate should be skipped',
              assignee: 'marketer',
              priority: 4,
              dueInHours: 12,
            },
          ],
        }),
        skillsCalled: [],
      }),
    });
    assert(spawnResult.createdTasks.length === 2, `expected 2 created tasks, got ${spawnResult.createdTasks.length}`);
    assert(spawnResult.createdTasks[0].title === 'Interview 3 churned users', 'first created task title preserved');
    assert(spawnResult.mission.tasks.some((sg) => sg.title === 'Interview 3 churned users'), 'created task inserted into tree');
    assert(spawnResult.mission.tasks.some((sg) => sg.title === 'Map onboarding email sequence'), 'second created task inserted into tree');
    const memoryAfterSpawn = readMissionMemory(created.id, { maxChars: 5000 });
    assert(/New tasks:/.test(memoryAfterSpawn), 'memory stores new tasks');

    assert(listMissions().missions.length === 1, 'single mission remains in store');
    const memoryAfterRun = readMissionMemory(created.id, { maxChars: 5000 });
    assert(/Learned:/.test(memoryAfterRun), 'memory stores learnings');
    assert(/Decisions:/.test(memoryAfterRun), 'memory stores decisions');
    assert(/User preferences:/.test(memoryAfterRun), 'memory stores user preferences');
    assert(/Did not work:/.test(memoryAfterRun), 'memory stores failed attempts');

    // Wait conditions: time-based waiting pauses due scheduling.
    updateMission(created.id, { nextRunAt: Date.now() - 1 });
    const waitUntil = Date.now() + 120_000;
    await runMissionTick(created.id, {
      runMissionTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Waiting for scheduled publish window.',
          progressPct: 42,
          wait: {
            kind: 'time',
            untilTs: waitUntil,
            reason: 'Await publish window opening',
          },
        }),
        skillsCalled: [],
      }),
    });
    const afterWaitTick = getMission(created.id);
    assert(afterWaitTick.waitCondition && afterWaitTick.waitCondition.kind === 'time', 'time wait condition stored');
    assert(listDueMissions().length === 0, 'time-waiting mission is not due');

    // Wait conditions: team activity watchers wake mission when event appears.
    const watcherMission = createMission({
      title: 'Wait for content-ready signal',
      objective: 'Resume when team emits content-ready',
      ownerAgentId: 'main',
      intervalMs: 30_000,
      waitCondition: {
        kind: 'team_activity',
        eventType: 'content_ready',
        messageIncludes: 'phase 1',
        reason: 'Need team signal before resuming',
      },
      nextRunAt: Date.now() - 1,
    });
    const beforeSignalDue = processDueMissionsInStore({ maxPerCycle: 10 }).map((g) => g.id);
    assert(!beforeSignalDue.includes(watcherMission.id), 'watcher mission not due before signal');
    logTeamActivity({ type: 'content_ready', message: 'phase 1 ready' });
    const afterSignalDue = processDueMissionsInStore({ maxPerCycle: 10 }).map((g) => g.id);
    assert(afterSignalDue.includes(watcherMission.id), 'watcher mission becomes due after signal');
    const watcherAfterSignal = getMission(watcherMission.id);
    assert(!watcherAfterSignal.waitCondition, 'watch condition clears after signal');

    await runMissionTick(created.id, {
      runMissionTurn: async () => {
        throw new Error('network unavailable');
      },
    });
    const afterError = listMissions().missions.find((g) => g.id === created.id);
    assert(afterError.status === 'blocked', `status blocked after error, got ${afterError.status}`);
    const memoryAfterError = readFileSync(memoryPath, 'utf8');
    assert(/Tick failed/.test(memoryAfterError), 'memory stores failure notes');

    updateMission(created.id, {
      status: 'active',
      needsUserInput: 'Which analytics vendor should we use?',
      waitCondition: {
        kind: 'partial',
        waitAppliesTo: 'implementation',
        blockedTaskIds: ['instrument-funnel'],
        reason: 'Awaiting analytics choice before instrumentation',
      },
      nextRunAt: Date.now() - 1,
    });
    const withPartial = getMission(created.id);
    assert(withPartial.waitCondition && withPartial.waitCondition.kind === 'partial', 'partial wait condition stored');
    assert(withPartial.waitCondition.waitAppliesTo === 'implementation', 'waitAppliesTo stored on partial wait');
    assert(listDueMissions().some((g) => g.id === created.id), 'partial-wait mission with user input stays due');

    const parts = partitionTasksByWait([
      { id: 'research-competitors', title: 'Competitor signup research', status: 'todo', progress: 0, tasks: [] },
      { id: 'instrument-funnel', title: 'Instrument funnel with PostHog', status: 'doing', progress: 10, tasks: [] },
      { id: 'stack-confirmation-config', title: 'Confirm analytics stack config', status: 'todo', progress: 0, tasks: [] },
    ], withPartial.waitCondition);
    assert(parts.actionable.some((sg) => sg.id === 'research-competitors'), 'research task stays actionable during implementation wait');
    assert(parts.blocked.some((sg) => sg.id === 'instrument-funnel'), 'explicit blockedTaskIds are blocked');
    assert(parts.blocked.some((sg) => sg.id === 'stack-confirmation-config'), 'implementation-scoped task blocked by waitAppliesTo');
    assert(taskBlockedByWait({ id: 'research-competitors', title: 'Competitor signup research', status: 'todo' }, withPartial.waitCondition) === false, 'research not blocked by implementation wait');

    updateMission(created.id, {
      waitCondition: { kind: 'manual', reason: 'Legacy manual wait' },
      nextRunAt: Date.now() - 1,
    });
    const legacyManual = getMission(created.id);
    assert(legacyManual.waitCondition && legacyManual.waitCondition.kind === 'partial', 'legacy manual wait normalizes to partial');
    assert(legacyManual.waitCondition.waitAppliesTo === 'implementation', 'legacy manual wait defaults waitAppliesTo to implementation');
    assert(listDueMissions().some((g) => g.id === created.id), 'legacy manual wait keeps mission due');

    updateMission(created.id, {
      tasks: [
        { id: 'blocked-a', title: 'Blocked branch A', status: 'blocked', progress: 0, tasks: [] },
        { id: 'open-b', title: 'Open branch B', status: 'todo', progress: 0, tasks: [] },
      ],
    });

    const responded = respondToMissionUserInput(created.id, 'PostHog with product analytics only');
    assert(!responded.needsUserInput, 'needsUserInput cleared after response');
    assert(!responded.waitCondition, 'wait condition cleared after response');
    assert(
      responded.tasks.some((sg) => sg.id === 'blocked-a' && sg.status === 'todo'),
      'blocked tasks reopen to todo after user response',
    );
    assert(
      responded.tasks.some((sg) => sg.id === 'open-b' && sg.status === 'todo'),
      'already-open tasks stay todo after user response',
    );
    assert(Number(responded.nextRunAt) <= Date.now(), 'mission scheduled immediately after response');
    assert(responded.lastActivity.includes('User responded'), 'last activity records user response');
    assert(listDueMissions().some((g) => g.id === created.id), 'mission is due again after user response');
    const memoryAfterRespond = readMissionMemory(created.id, { maxChars: 5000 });
    assert(/User input received:/.test(memoryAfterRespond), 'memory stores user input response');

    console.log('missions tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
