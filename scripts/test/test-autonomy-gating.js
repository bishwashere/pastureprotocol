#!/usr/bin/env node
/**
 * Unit tests for the autonomy-gate module.
 *
 * Verifies the architectural rule that autonomy loops (mission engine +
 * system pulse) do NOT come online until the user has at least one durable
 * mission. The contract:
 *
 *   1. hasAnyMission() returns false on a fresh state dir.
 *   2. maybeStartOnBoot() with no missions does NOT call the starter.
 *   3. Creating a mission via createMission() fires the starter exactly
 *      once (the "first mission" hook), regardless of how many more
 *      missions are created afterwards.
 *   4. maybeStartOnBoot() with at least one mission already on disk DOES
 *      call the starter on next boot.
 *   5. maybeStart() is idempotent across all entry points.
 *
 * Usage:
 *   node scripts/test/test-autonomy-gating.js
 *   pnpm run test:autonomy-gating
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-autonomy-test-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
    'utf8'
  );
  process.env.PASTURE_STATE_DIR = stateDir;
  return stateDir;
}

async function main() {
  setupStateDir();

  const {
    hasAnyMission,
    createMission,
  } = await import('../../lib/context/missions.js');
  const {
    configureAutonomy,
    maybeStartOnBoot,
    maybeStart,
    isAutonomyStarted,
    _resetForTests,
  } = await import('../../lib/agent/autonomy-gate.js');

  // ── 1. Fresh state dir: no missions ─────────────────────────────────────
  assert(hasAnyMission() === false, 'fresh state dir should have no missions');
  assert(isAutonomyStarted() === false, 'autonomy must not be started before configure');

  // ── 2. configureAutonomy + maybeStartOnBoot with no missions ─────────────
  _resetForTests();
  let starterCalls = 0;
  configureAutonomy(() => {
    starterCalls += 1;
  });
  const startedOnBoot = maybeStartOnBoot();
  assert(startedOnBoot === false, 'maybeStartOnBoot must return false when no missions');
  assert(starterCalls === 0, 'starter must NOT fire when no missions exist on boot');
  assert(isAutonomyStarted() === false, 'autonomy must remain off when no missions');

  // ── 3. Creating the first mission fires the starter (via the missions hook)
  const m1 = createMission({ title: 'first mission', objective: 'do thing one' });
  assert(m1 && m1.id, 'createMission should return a mission with an id');
  assert(hasAnyMission() === true, 'hasAnyMission must report true after createMission');
  assert(starterCalls === 1, `starter must fire exactly once on first mission (got ${starterCalls})`);
  assert(isAutonomyStarted() === true, 'autonomy must be marked as started');

  // ── 4. Creating a second mission does NOT re-fire the starter ────────────
  const m2 = createMission({ title: 'second mission', objective: 'do thing two' });
  assert(m2 && m2.id !== m1.id, 'createMission should return a distinct second mission');
  assert(starterCalls === 1, `starter must still be 1 after second mission (got ${starterCalls})`);

  // ── 5. maybeStart and maybeStartOnBoot are idempotent on a hot gate ──────
  const re = maybeStart();
  assert(re === false, 'maybeStart() must return false when already started');
  const re2 = maybeStartOnBoot();
  assert(re2 === false, 'maybeStartOnBoot() must return false when already started');
  assert(starterCalls === 1, 'starter calls must stay at 1 after idempotent retries');

  // ── 6. Fresh boot with missions already on disk ──────────────────────────
  // Simulate a new process by resetting the gate but keeping the store.
  _resetForTests();
  let bootStarterCalls = 0;
  configureAutonomy(() => {
    bootStarterCalls += 1;
  });
  assert(hasAnyMission() === true, 'missions still on disk after gate reset');
  const startedAgain = maybeStartOnBoot();
  assert(startedAgain === true, 'maybeStartOnBoot must start autonomy when missions exist on disk');
  assert(bootStarterCalls === 1, `boot starter must fire exactly once (got ${bootStarterCalls})`);

  // ── 7. Starter that throws does not crash, latch still flips ────────────
  _resetForTests();
  let throwingCalls = 0;
  configureAutonomy(() => {
    throwingCalls += 1;
    throw new Error('boom');
  });
  const r = maybeStart();
  assert(r === true, 'maybeStart() returns true even when starter throws');
  assert(throwingCalls === 1, 'throwing starter was still called');
  assert(isAutonomyStarted() === true, 'latch flips even on starter throw (no infinite retry)');

  console.log('Autonomy-gating test passed.');
}

main().catch((err) => {
  console.error('Autonomy-gating test failed:', err && err.message ? err.message : err);
  process.exit(1);
});
