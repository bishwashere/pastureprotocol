#!/usr/bin/env node
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-curiosity-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createGoal, getGoal, getGoalMemoryPath } = await import('../../lib/goals.js');
    const {
      buildCuriosityMomentumPrompt,
      listCuriosityCandidateGoals,
      parseCuriositySuggestion,
      applyCuriositySuggestion,
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
    assert(/IDLE SUGGESTION check/.test(prompt), 'curiosity prompt is suggestion-only');
    assert(/NOT a goal tick/.test(prompt), 'curiosity prompt says it is not a goal tick');
    assert(/Do NOT bump progressPct/.test(prompt), 'curiosity prompt forbids progress changes');
    assert(/hasSafeNextStep/.test(prompt), 'curiosity prompt includes suggestion schema');

    const parsed = parseCuriositySuggestion(JSON.stringify({
      hasSafeNextStep: true,
      suggestion: 'Read package.json for analytics deps',
      safeNextStep: 'Confirm analytics stack via package.json',
      rationale: 'Read-only and matches open research',
      existingSubgoalId: 'research',
    }));
    assert(parsed.hasSafeNextStep === true, 'parser accepts safe suggestion');
    assert(parsed.suggestion.includes('package.json'), 'parser keeps suggestion text');

    const idleMission = createGoal({
      title: 'Idle mission',
      objective: 'Should appear as curiosity candidate',
      ownerAgentId: 'main',
      status: 'active',
    });
    const oldTouch = Date.now() - (3 * 60 * 60_000);
    const { updateGoal } = await import('../../lib/goals.js');
    updateGoal(idleMission.id, {
      lastRunAt: oldTouch,
      lastCuriosityAt: 0,
      nextRunAt: Date.now() + 60_000,
    });
    updateGoal(mission.id, { lastRunAt: Date.now() - (30 * 60_000), nextRunAt: Date.now() + 60_000 });

    const candidates = listCuriosityCandidateGoals({
      now: Date.now(),
      idleMs: 2 * 60 * 60_000,
    });
    assert(candidates.some((g) => g.id === idleMission.id), 'idle mission listed as curiosity candidate');
    assert(!candidates.some((g) => g.id === mission.id), 'recently active mission not a curiosity candidate');

    const dueMission = createGoal({
      title: 'Due for tick',
      objective: 'Should be handled by goal engine instead',
      ownerAgentId: 'main',
      status: 'active',
    });
    updateGoal(dueMission.id, {
      lastRunAt: oldTouch,
      lastCuriosityAt: 0,
      nextRunAt: Date.now() - 1000,
    });
    const candidatesExcludingDue = listCuriosityCandidateGoals({
      now: Date.now(),
      idleMs: 2 * 60 * 60_000,
    });
    assert(!candidatesExcludingDue.some((g) => g.id === dueMission.id), 'due missions excluded from curiosity');

    const beforePct = getGoal(idleMission.id).progress.pct;
    const tickResult = await runCuriosityMomentumForGoal(idleMission.id, {
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          hasSafeNextStep: true,
          suggestion: 'Draft 3 competitor signup notes.',
          safeNextStep: 'Scan three competitor signup pages and capture friction points.',
          rationale: 'Read-only research aligned with mission.',
        }),
        skillsCalled: [],
      }),
    });
    assert(tickResult.suggestion.hasSafeNextStep === true, 'curiosity pass returns suggestion');
    assert(/Idle suggestion:/.test(tickResult.goal.lastActivity), 'goal lastActivity tagged as idle suggestion');
    assert(Number(getGoal(idleMission.id).lastCuriosityAt) > 0, 'lastCuriosityAt recorded');
    assert(getGoal(idleMission.id).progress.pct === beforePct, 'curiosity does not change progress');
    assert((getGoal(idleMission.id).subgoals || []).length === 0, 'curiosity does not create subgoals');
    const memoryPath = getGoalMemoryPath(idleMission.id);
    assert(existsSync(memoryPath), 'curiosity appends goal memory file');
    assert(/Idle suggestion:/.test(readFileSync(memoryPath, 'utf8')), 'goal memory records idle suggestion');

    const noStepMission = createGoal({
      title: 'Nothing safe',
      objective: 'Idle with no suggestion',
      ownerAgentId: 'main',
      status: 'active',
    });
    updateGoal(noStepMission.id, {
      lastRunAt: oldTouch,
      nextRunAt: Date.now() + 60_000,
    });
    const noStepResult = await runCuriosityMomentumForGoal(noStepMission.id, {
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({ hasSafeNextStep: false, suggestion: '' }),
        skillsCalled: [],
      }),
    });
    assert(/Idle check:/.test(noStepResult.goal.lastActivity), 'no suggestion records idle check only');

    const cycle = await runCuriosityMomentumCycle({
      force: true,
      minIntervalMs: 0,
      idleMs: 2 * 60 * 60_000,
      excludeGoalIds: [idleMission.id],
      runGoalTurn: async () => ({
        textToSend: JSON.stringify({
          hasSafeNextStep: true,
          suggestion: 'Light read-only research pass.',
          safeNextStep: 'Review open subgoals and pick the smallest next step.',
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
