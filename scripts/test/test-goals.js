#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-goals-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const {
      listGoals,
      createGoal,
      updateGoal,
      listDueGoals,
      runGoalTick,
      buildGoalTickPrompt,
    } = await import('../../lib/goals.js');

    const created = createGoal({
      title: 'Ship goals feature',
      objective: 'Implement persistent goals with autonomous ticks',
      ownerAgentId: 'main',
      intervalMs: 30_000,
    });
    assert(created.id && created.status === 'active', 'goal created as active');
    assert(Array.isArray(listGoals().goals) && listGoals().goals.length === 1, 'goal persisted');

    const prompt = buildGoalTickPrompt(created);
    assert(/Goal ID/.test(prompt) && /STRICT JSON/.test(prompt), 'goal tick prompt generated');

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
          planSteps: [
            { title: 'Implement store', status: 'done' },
            { title: 'Implement UI', status: 'doing' },
          ],
          subgoals: [
            { title: 'Add goals card test', objective: 'Add goals UI assertions', ownerAgentId: 'main' },
          ],
        }),
        skillsCalled: ['read', 'write'],
      }),
    });
    assert(runResult.goal.progress.pct === 42, `progress expected 42, got ${runResult.goal.progress.pct}`);
    assert(runResult.goal.lastActivity.includes('Gathered evidence'), 'summary persisted');
    assert(runResult.goal.running === false, 'goal not left running');
    assert(Array.isArray(runResult.createdSubgoals) && runResult.createdSubgoals.length === 1, 'subgoal created');
    assert(listGoals().goals.length === 2, 'goal + subgoal in store');

    await runGoalTick(created.id, {
      runGoalTurn: async () => {
        throw new Error('network unavailable');
      },
    });
    const afterError = listGoals().goals.find((g) => g.id === created.id);
    assert(afterError.status === 'blocked', `status blocked after error, got ${afterError.status}`);

    console.log('goals tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
