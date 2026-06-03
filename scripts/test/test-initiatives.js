#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-initiatives-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const {
      createInitiatives,
      listInitiatives,
      updateInitiative,
      analyzeTeamActivityForInitiatives,
    } = await import('../../lib/initiatives.js');
    const { logTeamActivity } = await import('../../lib/team-activity.js');

    const first = createInitiatives([
      {
        title: 'Users stop after signup',
        type: 'risk',
        description: 'Drop-off is high immediately after signup.',
        confidence: 0.85,
      },
      {
        title: 'Low-confidence noise',
        type: 'observation',
        description: 'Should be discarded',
        confidence: 0.2,
      },
    ], {
      source: 'goal_reflection',
      createdBy: 'marketer',
      relatedGoalIds: ['goal-1'],
      minConfidence: 0.6,
      maxPerBatch: 3,
    });
    assert(first.created.length === 1, `expected 1 initiative created, got ${first.created.length}`);
    assert(first.discarded.includes('low_confidence'), 'low confidence candidate discarded');

    const dupe = createInitiatives([
      {
        title: 'Users stop after signup',
        type: 'risk',
        description: 'Same risk with different wording.',
        confidence: 0.9,
      },
    ], {
      source: 'waiting_goal',
      createdBy: 'main',
      relatedGoalIds: ['goal-2'],
      minConfidence: 0.6,
    });
    assert(dupe.created.length === 0, 'duplicate not created again');
    assert(dupe.merged.length === 1, 'duplicate merged');

    const all = listInitiatives().initiatives;
    assert(all.length === 1, `expected 1 initiative in store after merge, got ${all.length}`);
    const updated = updateInitiative(all[0].id, { status: 'accepted' });
    assert(updated.status === 'accepted', 'status update works');

    // Team activity analysis should synthesize repeated failures.
    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    const analysis = analyzeTeamActivityForInitiatives({ minIntervalMs: 0 });
    assert((analysis.created.length + analysis.merged.length) >= 1, 'team analysis created or merged initiative');

    const { createGoal, getGoal } = await import('../../lib/goals.js');
    const {
      autoPromoteInitiatives,
      promoteInitiativeToSubgoal,
    } = await import('../../lib/initiatives.js');

    const mission = createGoal({
      title: 'Grow signups',
      objective: 'Increase signups',
      ownerAgentId: 'marketer',
      status: 'active',
    });

    const oldEnough = Date.now() - (31 * 60_000);
    const high = createInitiatives([{
      title: 'Add referral loop experiment',
      type: 'experiment',
      description: 'Test referral incentive on signup completion.',
      confidence: 0.82,
    }], {
      source: 'goal_reflection',
      createdBy: 'marketer',
      relatedGoalIds: [mission.id],
      minConfidence: 0.6,
    });
    assert(high.created.length === 1, 'high-confidence initiative created');
    updateInitiative(high.created[0].id, { createdAt: oldEnough, updatedAt: oldEnough });

    const low = createInitiatives([{
      title: 'Maybe tweak button color',
      type: 'observation',
      description: 'Low signal idea',
      confidence: 0.65,
    }], {
      source: 'goal_reflection',
      createdBy: 'marketer',
      relatedGoalIds: [mission.id],
      minConfidence: 0.6,
    });
    assert(low.created.length === 1, 'low-confidence initiative created for control');
    updateInitiative(low.created[0].id, { createdAt: oldEnough, updatedAt: oldEnough });

    const firstRun = await autoPromoteInitiatives({ minIntervalMs: 0, minAgeMs: 0, force: true });
    assert(firstRun.promoted.length === 1, `expected 1 auto-promotion, got ${firstRun.promoted.length}`);
    assert(firstRun.promoted[0].goalId === mission.id, 'promoted to related mission');

    const promotedInit = listInitiatives().initiatives.find((i) => i.id === high.created[0].id);
    assert(promotedInit.status === 'accepted', 'initiative marked accepted after auto-promote');
    assert((promotedInit.activity || []).some((line) => /Auto-promoted to subgoal/.test(line)), 'activity logs auto-promotion');

    const missionAfter = getGoal(mission.id);
    assert(
      (missionAfter.subgoals || []).some((sg) => sg.id === `init-${high.created[0].id}`),
      'subgoal inserted on mission',
    );

    const stillOpen = listInitiatives().initiatives.find((i) => i.id === low.created[0].id);
    assert(stillOpen.status === 'open', 'sub-threshold initiative stays open');

    const secondRun = await autoPromoteInitiatives({ minIntervalMs: 0, minAgeMs: 0, force: true });
    assert(secondRun.promoted.length === 0, 'already-promoted initiative not promoted again');

    const capMission = createGoal({
      title: 'Cap mission',
      objective: 'Test auto-promote daily cap',
      ownerAgentId: 'marketer',
      status: 'active',
    });
    for (let i = 0; i < 5; i++) {
      const batch = createInitiatives([{
        title: `Daily cap candidate ${i + 1}`,
        type: 'improvement',
        description: 'Should hit daily auto-promote cap',
        confidence: 0.9 - (i * 0.01),
      }], {
        source: 'goal_reflection',
        createdBy: 'marketer',
        relatedGoalIds: [capMission.id],
        minConfidence: 0.6,
      });
      updateInitiative(batch.created[0].id, { createdAt: oldEnough, updatedAt: oldEnough });
    }
    const capped = await autoPromoteInitiatives({ minIntervalMs: 0, minAgeMs: 0, force: true });
    assert(capped.promoted.length === 3, `daily auto-promote cap expected 3, got ${capped.promoted.length}`);
    assert(capped.skippedItems.some((row) => row.reason === 'daily_limit'), 'extra initiatives skipped by daily cap');

    const manual = createInitiatives([{
      title: 'Manual promote check',
      type: 'opportunity',
      description: 'Promoted via shared helper',
      confidence: 0.88,
    }], {
      source: 'goal_reflection',
      createdBy: 'marketer',
      relatedGoalIds: [mission.id],
      minConfidence: 0.6,
    });
    const manualResult = await promoteInitiativeToSubgoal(manual.created[0], mission.id);
    assert(manualResult.subgoalId, 'manual promote helper creates subgoal');

    console.log('initiatives tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
