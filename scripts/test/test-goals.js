#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-goals-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      listGoals,
      getGoal,
      createGoal,
      updateGoal,
      listDueGoals,
      processDueGoalsInStore,
      runGoalTick,
      buildGoalTickPrompt,
      getGoalMemoryPath,
      readGoalMemory,
      respondToGoalUserInput,
      partitionSubgoalsByWait,
      subgoalBlockedByWait,
      normalizeWaitAppliesTo,
    } = await import('../../lib/goals.js');
    const { logTeamActivity } = await import('../../lib/team-activity.js');

    const created = createGoal({
      title: 'Ship goals feature',
      objective: 'Implement persistent goals with autonomous ticks',
      ownerAgentId: 'main',
      intervalMs: 30_000,
      subgoals: [
        { id: 'research', title: 'Research', status: 'doing', progress: 40, assignee: 'marketer', depends_on: [] },
      ],
    });
    assert(created.id && created.status === 'active', 'goal created as active');
    assert(Array.isArray(created.subgoals) && created.subgoals.length === 1, 'initial subgoals normalized');
    assert(Array.isArray(listGoals().goals) && listGoals().goals.length === 1, 'goal persisted');

    const prompt = buildGoalTickPrompt(created);
    assert(/Goal ID/.test(prompt) && /STRICT JSON/.test(prompt), 'goal tick prompt generated');
    assert(/1\) Review/.test(prompt), 'prompt includes review section');
    assert(/2\) Progress Evaluation/.test(prompt), 'prompt includes progress evaluation section');
    assert(/3\) Next Action Selection/.test(prompt), 'prompt includes next action selection section');
    assert(/4\) Delegation Check/.test(prompt), 'prompt includes delegation check section');
    assert(/5\) Reflection & Memory Update/.test(prompt), 'prompt includes reflection section');
    assert(/6\) User Input Check/.test(prompt), 'prompt includes user input check section');
    assert(/7\) Waiting \/ Watchers \/ Conditions/.test(prompt), 'prompt includes waiting section');
    assert(/8\) Opportunity Detection/.test(prompt), 'prompt includes opportunity detection section');
    assert(/"userInputRequired": false/.test(prompt), 'prompt includes user input required flag');
    assert(/partial wait does NOT pause goal ticks/.test(prompt), 'prompt explains partial wait keeps ticking');
    assert(/waitAppliesTo/.test(prompt), 'prompt includes waitAppliesTo');
    const partialPrompt = buildGoalTickPrompt({
      ...created,
      waitCondition: {
        kind: 'partial',
        waitAppliesTo: 'implementation',
        reason: 'Await analytics vendor',
      },
      subgoals: [
        { id: 'research-competitors', title: 'Competitor signup research', status: 'todo', progress: 0, subgoals: [] },
        { id: 'instrument-funnel', title: 'Instrument funnel with PostHog', status: 'doing', progress: 10, subgoals: [] },
      ],
    });
    assert(/Actionable branches/.test(partialPrompt), 'prompt lists actionable branches during wait');
    assert(/Blocked branches/.test(partialPrompt), 'prompt lists blocked branches during wait');
    assert(/"wait":/.test(prompt), 'prompt includes wait schema');
    assert(/partial/.test(prompt), 'prompt includes partial wait kind');
    assert(/9\) Curiosity & Next Steps/.test(prompt), 'prompt includes curiosity section');
    assert(/createdSubgoals/.test(prompt), 'prompt includes createdSubgoals schema');
    assert(/"initiatives": \[\{/.test(prompt), 'prompt includes initiatives schema');
    const memoryPath = getGoalMemoryPath(created.id);
    assert(existsSync(memoryPath), 'goal memory file created');
    assert(/Per-goal memory file path/.test(prompt), 'prompt includes memory path');

    updateGoal(created.id, { nextRunAt: Date.now() - 1 });
    assert(listDueGoals().length === 1, 'goal is due');

    const runResult = await runGoalTick(created.id, {
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Gathered evidence and updated plan.',
          progressPct: 42,
          evidence: ['checked team activity', 'drafted goals UI'],
          currentStep: 'Building dashboard tab',
          nextRunInSec: 45,
          contextSnapshot: 'UI and API partially implemented',
          memoryAnchors: ['goal=ship-goals', 'phase=ui'],
          learnings: ['Scoring should happen before planning'],
          decisions: ['Keep Team tab as default agent space'],
          userPreferences: ['Prefer concise status cards'],
          failedAttempts: ['Initial goals card had no owner badge'],
          planSteps: [
            { title: 'Implement store', status: 'done' },
            { title: 'Implement UI', status: 'doing' },
          ],
          subgoals: [
            {
              id: 'research',
              title: 'Research',
              status: 'done',
              progress: 100,
              assignee: 'marketer',
              depends_on: [],
              subgoals: [],
            },
            {
              id: 'calendar',
              title: 'Content Calendar',
              status: 'doing',
              progress: 35,
              assignee: 'main',
              depends_on: ['research'],
              subgoals: [
                {
                  id: 'production',
                  title: 'Production',
                  status: 'todo',
                  progress: 0,
                  assignee: 'main',
                  depends_on: ['calendar'],
                  subgoals: [
                    {
                      id: 'promotion',
                      title: 'Promotion',
                      status: 'todo',
                      progress: 0,
                      assignee: 'marketer',
                      depends_on: ['production'],
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
    assert(runResult.goal.progress.pct === 42, `progress expected 42, got ${runResult.goal.progress.pct}`);
    assert(runResult.goal.lastActivity.includes('Gathered evidence'), 'summary persisted');
    assert(runResult.goal.running === false, 'goal not left running');
    assert(Array.isArray(runResult.goal.subgoals) && runResult.goal.subgoals.length === 2, 'goal subgoal tree saved');
    assert(runResult.goal.subgoals[1].depends_on.includes('research'), 'subgoal dependency saved');
    assert(runResult.goal.subgoals[1].subgoals[0].subgoals[0].title === 'Promotion', 'nested subgoal saved');
    assert(Array.isArray(runResult.createdSubgoals) && runResult.createdSubgoals.length === 0, 'no createdSubgoals when field omitted');

    updateGoal(created.id, { nextRunAt: Date.now() - 1, status: 'active' });
    const spawnResult = await runGoalTick(created.id, {
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Discovered follow-up research tasks.',
          progressPct: 45,
          subgoals: [
            {
              id: 'research',
              title: 'Research',
              status: 'done',
              progress: 100,
              assignee: 'marketer',
              depends_on: [],
              subgoals: [],
            },
          ],
          createdSubgoals: [
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
    assert(spawnResult.createdSubgoals.length === 2, `expected 2 created subgoals, got ${spawnResult.createdSubgoals.length}`);
    assert(spawnResult.createdSubgoals[0].title === 'Interview 3 churned users', 'first created subgoal title preserved');
    assert(spawnResult.goal.subgoals.some((sg) => sg.title === 'Interview 3 churned users'), 'created subgoal inserted into tree');
    assert(spawnResult.goal.subgoals.some((sg) => sg.title === 'Map onboarding email sequence'), 'second created subgoal inserted into tree');
    const memoryAfterSpawn = readGoalMemory(created.id, { maxChars: 5000 });
    assert(/New subgoals:/.test(memoryAfterSpawn), 'memory stores new subgoals');

    assert(listGoals().goals.length === 1, 'single goal remains in store');
    const memoryAfterRun = readGoalMemory(created.id, { maxChars: 5000 });
    assert(/Learned:/.test(memoryAfterRun), 'memory stores learnings');
    assert(/Decisions:/.test(memoryAfterRun), 'memory stores decisions');
    assert(/User preferences:/.test(memoryAfterRun), 'memory stores user preferences');
    assert(/Did not work:/.test(memoryAfterRun), 'memory stores failed attempts');

    // Wait conditions: time-based waiting pauses due scheduling.
    updateGoal(created.id, { nextRunAt: Date.now() - 1 });
    const waitUntil = Date.now() + 120_000;
    await runGoalTick(created.id, {
      runGoalTurn: async () => ({
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
    const afterWaitTick = getGoal(created.id);
    assert(afterWaitTick.waitCondition && afterWaitTick.waitCondition.kind === 'time', 'time wait condition stored');
    assert(listDueGoals().length === 0, 'time-waiting goal is not due');

    // Wait conditions: team activity watchers wake goal when event appears.
    const watcherGoal = createGoal({
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
    const beforeSignalDue = processDueGoalsInStore({ maxPerCycle: 10 }).map((g) => g.id);
    assert(!beforeSignalDue.includes(watcherGoal.id), 'watcher goal not due before signal');
    logTeamActivity({ type: 'content_ready', message: 'phase 1 ready' });
    const afterSignalDue = processDueGoalsInStore({ maxPerCycle: 10 }).map((g) => g.id);
    assert(afterSignalDue.includes(watcherGoal.id), 'watcher goal becomes due after signal');
    const watcherAfterSignal = getGoal(watcherGoal.id);
    assert(!watcherAfterSignal.waitCondition, 'watch condition clears after signal');

    await runGoalTick(created.id, {
      runGoalTurn: async () => {
        throw new Error('network unavailable');
      },
    });
    const afterError = listGoals().goals.find((g) => g.id === created.id);
    assert(afterError.status === 'blocked', `status blocked after error, got ${afterError.status}`);
    const memoryAfterError = readFileSync(memoryPath, 'utf8');
    assert(/Tick failed/.test(memoryAfterError), 'memory stores failure notes');

    updateGoal(created.id, {
      status: 'active',
      needsUserInput: 'Which analytics vendor should we use?',
      waitCondition: {
        kind: 'partial',
        waitAppliesTo: 'implementation',
        blockedSubgoalIds: ['instrument-funnel'],
        reason: 'Awaiting analytics choice before instrumentation',
      },
      nextRunAt: Date.now() - 1,
    });
    const withPartial = getGoal(created.id);
    assert(withPartial.waitCondition && withPartial.waitCondition.kind === 'partial', 'partial wait condition stored');
    assert(withPartial.waitCondition.waitAppliesTo === 'implementation', 'waitAppliesTo stored on partial wait');
    assert(listDueGoals().some((g) => g.id === created.id), 'partial-wait goal with user input stays due');

    const parts = partitionSubgoalsByWait([
      { id: 'research-competitors', title: 'Competitor signup research', status: 'todo', progress: 0, subgoals: [] },
      { id: 'instrument-funnel', title: 'Instrument funnel with PostHog', status: 'doing', progress: 10, subgoals: [] },
      { id: 'stack-confirmation-config', title: 'Confirm analytics stack config', status: 'todo', progress: 0, subgoals: [] },
    ], withPartial.waitCondition);
    assert(parts.actionable.some((sg) => sg.id === 'research-competitors'), 'research subgoal stays actionable during implementation wait');
    assert(parts.blocked.some((sg) => sg.id === 'instrument-funnel'), 'explicit blockedSubgoalIds are blocked');
    assert(parts.blocked.some((sg) => sg.id === 'stack-confirmation-config'), 'implementation-scoped subgoal blocked by waitAppliesTo');
    assert(subgoalBlockedByWait({ id: 'research-competitors', title: 'Competitor signup research', status: 'todo' }, withPartial.waitCondition) === false, 'research not blocked by implementation wait');

    updateGoal(created.id, {
      waitCondition: { kind: 'manual', reason: 'Legacy manual wait' },
      nextRunAt: Date.now() - 1,
    });
    const legacyManual = getGoal(created.id);
    assert(legacyManual.waitCondition && legacyManual.waitCondition.kind === 'partial', 'legacy manual wait normalizes to partial');
    assert(legacyManual.waitCondition.waitAppliesTo === 'implementation', 'legacy manual wait defaults waitAppliesTo to implementation');
    assert(listDueGoals().some((g) => g.id === created.id), 'legacy manual wait keeps goal due');

    updateGoal(created.id, {
      subgoals: [
        { id: 'blocked-a', title: 'Blocked branch A', status: 'blocked', progress: 0, subgoals: [] },
        { id: 'open-b', title: 'Open branch B', status: 'todo', progress: 0, subgoals: [] },
      ],
    });

    const responded = respondToGoalUserInput(created.id, 'PostHog with product analytics only');
    assert(!responded.needsUserInput, 'needsUserInput cleared after response');
    assert(!responded.waitCondition, 'wait condition cleared after response');
    assert(
      responded.subgoals.some((sg) => sg.id === 'blocked-a' && sg.status === 'todo'),
      'blocked subgoals reopen to todo after user response',
    );
    assert(
      responded.subgoals.some((sg) => sg.id === 'open-b' && sg.status === 'todo'),
      'already-open subgoals stay todo after user response',
    );
    assert(Number(responded.nextRunAt) <= Date.now(), 'goal scheduled immediately after response');
    assert(responded.lastActivity.includes('User responded'), 'last activity records user response');
    assert(listDueGoals().some((g) => g.id === created.id), 'goal is due again after user response');
    const memoryAfterRespond = readGoalMemory(created.id, { maxChars: 5000 });
    assert(/User input received:/.test(memoryAfterRespond), 'memory stores user input response');

    console.log('goals tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
