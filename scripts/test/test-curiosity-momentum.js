#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-curiosity-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { createGoal, getGoal } = await import('../../lib/goals.js');
    const {
      buildCuriosityMomentumPrompt,
      listCuriosityCandidateGoals,
      runCuriosityMomentumForGoal,
      runCuriosityMomentumCycle,
    } = await import('../../lib/curiosity-momentum.js');

    const mission = createGoal({
      title: 'Grow signups',
      objective: 'Increase signups',
      ownerAgentId: 'marketer',
      status: 'active',
      subgoals: [
        { id: 'research', title: 'Competitor signup research', status: 'todo', progress: 0, assignee: 'marketer', subgoals: [] },
      ],
    });

    const prompt = buildCuriosityMomentumPrompt(mission, {
      memoryPath: '/tmp/goal-memory.md',
      goalMemory: 'Previous tick reviewed landing page.',
      idleHours: 2.5,
    });
    assert(/CURIOSITY & MOMENTUM pass/.test(prompt), 'curiosity prompt generated');
    assert(/max 2/.test(prompt), 'curiosity prompt limits created subgoals');
    assert(/high-stakes/.test(prompt), 'curiosity prompt restricts user input to high-stakes');
    assert(/createdSubgoals/.test(prompt), 'curiosity prompt includes createdSubgoals schema');

    const idleMission = createGoal({
      title: 'Idle mission',
      objective: 'Should appear as curiosity candidate',
      ownerAgentId: 'main',
      status: 'active',
    });
    const oldTouch = Date.now() - (3 * 60 * 60_000);
    const { updateGoal } = await import('../../lib/goals.js');
    updateGoal(idleMission.id, { lastRunAt: oldTouch, lastCuriosityAt: 0 });
    updateGoal(mission.id, { lastRunAt: Date.now() - (30 * 60_000) });

    const candidates = listCuriosityCandidateGoals({
      now: Date.now(),
      idleMs: 2 * 60 * 60_000,
    });
    assert(candidates.some((g) => g.id === idleMission.id), 'idle mission listed as curiosity candidate');
    assert(!candidates.some((g) => g.id === mission.id), 'recently active mission not a curiosity candidate');

    const tickResult = await runCuriosityMomentumForGoal(idleMission.id, {
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Drafted 3 competitor signup notes.',
          progressPct: 8,
          createdSubgoals: [{
            title: 'Summarize competitor onboarding emails',
            description: 'Capture subject lines and timing from 3 competitors',
            assignee: 'marketer',
            priority: 3,
            dueInHours: 2,
          }],
        }),
        skillsCalled: ['read'],
      }),
    });
    assert(tickResult.createdSubgoals.length === 1, 'curiosity pass creates subgoal');
    assert(/Curiosity momentum:/.test(tickResult.goal.lastActivity), 'goal lastActivity tagged as curiosity');
    assert(Number(getGoal(idleMission.id).lastCuriosityAt) > 0, 'lastCuriosityAt recorded');

    const cycle = await runCuriosityMomentumCycle({
      force: true,
      minIntervalMs: 0,
      idleMs: 2 * 60 * 60_000,
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          status: 'active',
          summary: 'Light research pass.',
          progressPct: 5,
          createdSubgoals: [],
        }),
        skillsCalled: [],
      }),
    });
    assert(Array.isArray(cycle.results), 'cycle returns results array');

    const interval = await runCuriosityMomentumCycle({
      minIntervalMs: 60 * 60_000,
      runGoalTurn: async () => ({ textToSend: '{}' }),
    });
    assert(interval.skipped === 'interval', 'cycle respects interval guard');

    console.log('curiosity momentum tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
