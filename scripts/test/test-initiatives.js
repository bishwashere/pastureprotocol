#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-initiatives-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      createInitiatives,
      listInitiatives,
      updateInitiative,
      analyzeTeamActivityForInitiatives,
      isInitiativeAwaitingApproval,
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
    assert(first.created[0].status === 'proposed', 'new initiatives start as proposed');
    assert(first.discarded.includes('low_confidence'), 'low confidence candidate discarded');
    assert(isInitiativeAwaitingApproval(first.created[0]), 'created initiative awaits approval');

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

    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'goal_tick_error', message: 'analytics data missing from warehouse' });
    const analysis = analyzeTeamActivityForInitiatives({ minIntervalMs: 0 });
    assert((analysis.created.length + analysis.merged.length) >= 1, 'team analysis created or merged initiative');
    if (analysis.created.length) {
      assert(analysis.created[0].status === 'proposed', 'team analysis creates proposals only');
    }

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

    const disabled = await autoPromoteInitiatives({ minIntervalMs: 0, minAgeMs: 0, force: true });
    assert(disabled.skipped === 'disabled', 'auto-promotion disabled by default');
    assert(disabled.promoted.length === 0, 'no auto-promotion without explicit enable');

    const missionBeforeApprove = getGoal(mission.id);
    assert(
      !(missionBeforeApprove.subgoals || []).some((sg) => sg.id === `init-${high.created[0].id}`),
      'proposal does not become subgoal until approved',
    );

    const manualResult = await promoteInitiativeToSubgoal(high.created[0], mission.id);
    assert(manualResult.subgoalId, 'manual approval creates subgoal');

    const approvedInit = listInitiatives().initiatives.find((i) => i.id === high.created[0].id);
    assert(approvedInit.status === 'accepted', 'initiative marked accepted after approval');
    assert(
      (approvedInit.activity || []).some((line) => /Approved and added to mission/.test(line)),
      'activity logs manual approval',
    );

    const missionAfter = getGoal(mission.id);
    assert(
      (missionAfter.subgoals || []).some((sg) => sg.id === `init-${high.created[0].id}`),
      'subgoal inserted on mission after approval',
    );

    const enabled = await autoPromoteInitiatives({
      enabled: true,
      minIntervalMs: 0,
      minAgeMs: 0,
      force: true,
    });
    assert(Array.isArray(enabled.promoted), 'enabled auto-promote still returns promoted array');

    console.log('initiatives tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
