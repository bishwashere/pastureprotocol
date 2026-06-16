#!/usr/bin/env node
/**
 * Tests for system-pulse: health check + output pattern detection.
 * Uses real system entry points — no mocks.
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-pulse-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.PASTURE_PULSE_DRY_RUN = '1';

  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(join(stateDir, 'workspace', 'SOUL.md'), 'You are Pasture Protocol. A helpful assistant.\n', 'utf8');

  writeFileSync(join(stateDir, 'daemon.log'), [
    '[Telegram] No poll activity for 8+ min; restarting polling as a precaution.',
    '[Telegram] Polling restarted successfully.',
    '[Telegram] No poll activity for 8+ min; restarting polling as a precaution.',
    '[Telegram] Polling restarted successfully.',
  ].join('\n'), 'utf8');

  writeFileSync(join(stateDir, 'daemon.err'), [
    '[cron] Job failed (attempt 1/3) Reminder No transport to send cron reply',
    '[cron] Job failed (attempt 2/3) Reminder No transport to send cron reply',
    '[cron] Job failed Reminder No transport to send cron reply',
    '[cron] Job failed (attempt 1/3) Reminder run-job exited with code 1',
    '[cron] Job failed (attempt 2/3) Reminder run-job exited with code 1',
    '[cron] Job failed Reminder run-job exited with code 1',
    '[skills] search page.goto: net::ERR_HTTP2_PROTOCOL_ERROR',
  ].join('\n'), 'utf8');

  try {
    const {
      runHealthCheck,
      loadPulseConfig,
      isPulseEnabled,
      getPendingHealthFlags,
    } = await import('../../lib/agent/system-pulse.js');

    const cfg = loadPulseConfig();
    assert(cfg.enabled === true, 'default config enabled');
    assert(cfg.healthIntervalMinutes === 45, 'default health interval');
    assert(cfg.patternIntervalHours === 8, 'default pattern interval');
    assert(cfg.maxPatternsPerRun === 2, 'default max patterns');
    assert(isPulseEnabled(), 'pulse enabled by default');

    const health = await runHealthCheck();
    assert(health.checkedAt > 0, 'health check ran');
    assert(Array.isArray(health.repeatedErrors), 'repeated errors detected');

    const cronErrors = health.repeatedErrors.filter((e) => e.pattern.includes('cron'));
    assert(cronErrors.length > 0, 'cron errors detected from daemon.err');
    assert(cronErrors[0].count >= 3, 'cron error count >= 3');

    assert(health.disk && health.disk.status, 'disk check ran');
    assert(health.transport && health.transport.status, 'transport check ran');
    assert(health.llm && health.llm.status, 'LLM reachability check ran');

    const flags = getPendingHealthFlags();
    assert(typeof flags === 'string', 'health flags is string');

    const healthFile = join(stateDir, 'health.json');
    assert(existsSync(healthFile), 'health.json written');
    const healthData = JSON.parse(readFileSync(healthFile, 'utf8'));
    assert(healthData.checkedAt > 0, 'health.json has timestamp');

    console.log('system-pulse tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
