#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-suggestedTasks-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      createSuggestedTasks,
      listSuggestedTasks,
      updateSuggestedTask,
      analyzeTeamActivityForSuggestedTasks,
      isSuggestedTaskAwaitingApproval,
    } = await import('../../lib/context/ai-suggested-tasks.js');
    const { logTeamActivity } = await import('../../lib/agent/team-activity.js');

    const first = createSuggestedTasks([
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
      source: 'mission_reflection',
      createdBy: 'marketer',
      relatedMissionIds: ['mission-1'],
      minConfidence: 0.6,
      maxPerBatch: 3,
    });
    assert(first.created.length === 1, `expected 1 suggestedTask created, got ${first.created.length}`);
    assert(first.created[0].status === 'proposed', 'new suggestedTasks start as proposed');
    assert(first.discarded.includes('low_confidence'), 'low confidence candidate discarded');
    assert(isSuggestedTaskAwaitingApproval(first.created[0]), 'created suggestedTask awaits approval');

    const dupe = createSuggestedTasks([
      {
        title: 'Users stop after signup',
        type: 'risk',
        description: 'Same risk with different wording.',
        confidence: 0.9,
      },
    ], {
      source: 'waiting_mission',
      createdBy: 'main',
      relatedMissionIds: ['mission-2'],
      minConfidence: 0.6,
    });
    assert(dupe.created.length === 0, 'duplicate not created again');
    assert(dupe.merged.length === 1, 'duplicate merged');

    const all = listSuggestedTasks().suggestedTasks;
    assert(all.length === 1, `expected 1 suggestedTask in store after merge, got ${all.length}`);
    const updated = updateSuggestedTask(all[0].id, { status: 'accepted' });
    assert(updated.status === 'accepted', 'status update works');

    logTeamActivity({ type: 'mission_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'mission_tick_error', message: 'analytics data missing from warehouse' });
    logTeamActivity({ type: 'mission_tick_error', message: 'analytics data missing from warehouse' });
    const analysis = analyzeTeamActivityForSuggestedTasks({ minIntervalMs: 0 });
    assert((analysis.created.length + analysis.merged.length) >= 1, 'team analysis created or merged suggestedTask');
    if (analysis.created.length) {
      assert(analysis.created[0].status === 'proposed', 'team analysis creates proposals only');
    }

    const { createMission, getMission } = await import('../../lib/context/missions.js');
    const {
      autoPromoteSuggestedTasks,
      promoteSuggestedTaskToTask,
    } = await import('../../lib/context/ai-suggested-tasks.js');

    const mission = createMission({
      title: 'Grow signups',
      objective: 'Increase signups',
      ownerAgentId: 'marketer',
      status: 'active',
    });

    const oldEnough = Date.now() - (31 * 60_000);
    const high = createSuggestedTasks([{
      title: 'Add referral loop experiment',
      type: 'experiment',
      description: 'Test referral incentive on signup completion.',
      confidence: 0.82,
    }], {
      source: 'mission_reflection',
      createdBy: 'marketer',
      relatedMissionIds: [mission.id],
      minConfidence: 0.6,
    });
    assert(high.created.length === 1, 'high-confidence suggestedTask created');
    updateSuggestedTask(high.created[0].id, { createdAt: oldEnough, updatedAt: oldEnough });

    const disabled = await autoPromoteSuggestedTasks({ minIntervalMs: 0, minAgeMs: 0, force: true });
    assert(disabled.skipped === 'disabled', 'auto-promotion disabled by default');
    assert(disabled.promoted.length === 0, 'no auto-promotion without explicit enable');

    const missionBeforeApprove = getMission(mission.id);
    assert(
      !(missionBeforeApprove.tasks || []).some((sg) => sg.id === `init-${high.created[0].id}`),
      'proposal does not become task until approved',
    );

    const manualResult = await promoteSuggestedTaskToTask(high.created[0], mission.id);
    assert(manualResult.taskId, 'manual approval creates task');

    const approvedInit = listSuggestedTasks().suggestedTasks.find((i) => i.id === high.created[0].id);
    assert(approvedInit.status === 'accepted', 'suggestedTask marked accepted after approval');
    assert(
      (approvedInit.activity || []).some((line) => /Approved and added to mission/.test(line)),
      'activity logs manual approval',
    );

    const missionAfter = getMission(mission.id);
    assert(
      (missionAfter.tasks || []).some((sg) => sg.id === `init-${high.created[0].id}`),
      'task inserted on mission after approval',
    );

    const enabled = await autoPromoteSuggestedTasks({
      enabled: true,
      minIntervalMs: 0,
      minAgeMs: 0,
      force: true,
    });
    assert(Array.isArray(enabled.promoted), 'enabled auto-promote still returns promoted array');

    console.log('suggestedTasks tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
