#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-team-activity-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { logTeamActivity, readTeamActivity } = await import('../../lib/team-activity.js');

    logTeamActivity({
      type: 'delegation_decision',
      agentId: 'main',
      targetAgentId: 'marketer',
      message: 'Delegation decision selected marketer',
      details: {
        reason: 'Request contains marketing concepts.',
        selected: 'marketer',
        selectedConfidence: 0.92,
        candidates: [
          { agentId: 'marketer', confidence: 0.92, score: 46 },
          { agentId: 'alex', confidence: 0.31, score: 15 },
        ],
      },
    });

    const events = readTeamActivity({ since: 0, limit: 5 });
    assert(Array.isArray(events) && events.length > 0, 'Expected at least one team activity event');
    const row = events[events.length - 1];
    assert(row.type === 'delegation_decision', `Expected delegation_decision event, got ${row.type}`);
    assert(row.targetAgentId === 'marketer', `Expected target marketer, got ${row.targetAgentId}`);
    assert(row.details && typeof row.details === 'object', 'Expected details object to be persisted');
    assert(row.details.reason === 'Request contains marketing concepts.', `Unexpected reason: ${row.details.reason}`);
    assert(Array.isArray(row.details.candidates) && row.details.candidates.length === 2, 'Expected two candidate rows');

    console.log('team-activity tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});

