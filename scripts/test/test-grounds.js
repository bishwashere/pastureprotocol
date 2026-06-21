#!/usr/bin/env node
/**
 * Unit tests for system grounds catalog (dashboard Grounds page).
 */
import { listSystemGrounds } from '../../lib/util/grounds.js';

function check(label, ok, detail = '') {
  const status = ok ? '✅ Pass' : '❌ Fail';
  console.log(`| ${label} | ${detail || '—'} | ${detail || '—'} | ${status} |`);
  if (!ok) process.exitCode = 1;
}

console.log('| Test | Input | Output | Status |');
console.log('|------|-------|--------|--------|');

const base = listSystemGrounds({}, { activeMissionCount: 0 });
check('includes cron runner', base.some((g) => g.id === 'cron-runner'), 'cron-runner');
check('includes system pulse health', base.some((g) => g.id === 'system-pulse-health'), 'system-pulse-health');
check('includes retrospective', base.some((g) => g.id === 'retrospective'), 'retrospective');

const tideOff = listSystemGrounds({ tide: { enabled: false } });
const tideFollow = tideOff.find((g) => g.id === 'tide-followup');
check('tide follow-up disabled when tide off', tideFollow && tideFollow.enabled === false, 'enabled=false');

const tideOn = listSystemGrounds({
  tide: {
    enabled: true,
    silenceCooldownMinutes: 45,
    healthCheckMinutes: 5,
    checklist: { enabled: true, triggers: { onRestart: true, onCycle: true }, items: [{ id: 'a', label: 'Ping', enabled: true }] },
  },
});
const checklist = tideOn.find((g) => g.id === 'tide-checklist');
check('tide checklist enabled with items', checklist && checklist.enabled === true, checklist?.detail || '');

const withMissions = listSystemGrounds({}, { activeMissionCount: 2 });
const curiosity = withMissions.find((g) => g.id === 'mission-curiosity');
check('curiosity enabled with active missions', curiosity && curiosity.enabled === true, curiosity?.detail || '');

const pulseOff = listSystemGrounds({ systemPulse: { enabled: false } });
const health = pulseOff.find((g) => g.id === 'system-pulse-health');
check('pulse health respects enabled flag', health && health.enabled === false, 'enabled=false');

if (process.exitCode) {
  console.error('\nSome grounds tests failed.');
  process.exit(process.exitCode);
}
console.log('\nAll grounds tests passed.');
