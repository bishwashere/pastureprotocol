/**
 * Autonomy gate — controls when the agent's "autonomy loops" come online.
 *
 * Per the architecture (see AGENTS.md): the default state of the agent is
 * single-shot, request/response. It takes a message, runs skills, and
 * replies. There is no background work happening.
 *
 * "Autonomy loops" — the mission engine (curiosity-momentum cycle +
 * AI-suggested-tasks scan + due-mission ticking) and the system pulse
 * (periodic health check + self-edit pattern detector) — only make sense
 * once the user has at least one durable mission for the agent to
 * maintain. Until then, starting these timers wastes LLM calls and adds
 * surface area for failures the user can't even see.
 *
 * This module is the single place that decides "is autonomy on?". It is
 * intentionally tiny: it holds the starter callback, tracks whether
 * autonomy has been started already, and exposes:
 *
 *   - configureAutonomy(starterFn): register the function that boots the
 *     loops. The caller (index.js) wires startMissionEngine + startSystemPulse.
 *   - maybeStartOnBoot(): called once at daemon start. Boots autonomy iff
 *     missions already exist on disk.
 *   - onMissionCreated(): called by missions.js after a mission is created.
 *     Boots autonomy if not already running.
 *
 * Tests can call _resetForTests() between cases.
 */

import { hasAnyMission, setOnMissionCreated } from '../context/missions.js';

let starterFn = null;
let started = false;

/**
 * Register the starter callback. Idempotent — the second call replaces
 * the first. The callback is invoked at most once across the daemon's
 * lifetime (the `started` latch prevents re-entry).
 *
 * Also wires the missions.js -> autonomy-gate notification so creating
 * the first mission turns the loops on without any explicit call site.
 *
 * @param {() => void} fn
 */
export function configureAutonomy(fn) {
  starterFn = typeof fn === 'function' ? fn : null;
  setOnMissionCreated((event) => onMissionCreated(event));
}

/**
 * Run the starter callback once. Subsequent calls are no-ops.
 *
 * @returns {boolean} true if this call actually started autonomy.
 */
export function maybeStart() {
  if (started) return false;
  if (!starterFn) return false;
  started = true;
  try {
    starterFn();
  } catch (err) {
    console.log('[autonomy-gate] starter threw:', err?.message || err);
  }
  return true;
}

/**
 * Boot-time entry point. Inspects the missions store and starts autonomy
 * only if at least one mission already exists. Called once from index.js
 * after migrations have run.
 *
 * @returns {boolean} true if autonomy was started.
 */
export function maybeStartOnBoot() {
  if (started) return false;
  if (!hasAnyMission()) {
    console.log('[autonomy-gate] no missions on disk — autonomy loops parked');
    return false;
  }
  console.log('[autonomy-gate] missions present on boot — starting autonomy loops');
  return maybeStart();
}

/**
 * Notification from missions.js when a mission is created. Starts
 * autonomy the first time this fires (later mission creations are no-ops
 * because the latch is already set).
 *
 * @param {{ missionId: string, isFirst: boolean }} event
 */
export function onMissionCreated(event) {
  if (started) return false;
  if (!event?.isFirst && !hasAnyMission()) return false;
  console.log('[autonomy-gate] first mission created — starting autonomy loops');
  return maybeStart();
}

/**
 * True when autonomy has been started this process.
 *
 * @returns {boolean}
 */
export function isAutonomyStarted() {
  return started;
}

/**
 * Test hook: forget the registered starter and reset the latch so the
 * next configureAutonomy / maybeStart pair behaves as if fresh.
 *
 * Not for production use.
 */
export function _resetForTests() {
  starterFn = null;
  started = false;
  setOnMissionCreated(null);
}
