/**
 * Grounds — scheduled work inside and outside the Pasture system.
 *
 * Scheduled grounds: user reminders in cron/jobs.json (part of the pasture).
 * System grounds: daemon-level timers (just outside the pasture, for the system).
 */

import { getRetrospectiveConfig } from '../agent/retrospective.js';
import { normalizeChecklistConfig } from '../agent/tide-checklist.js';

const PULSE_DEFAULTS = {
  enabled: true,
  healthIntervalMinutes: 45,
  patternIntervalHours: 8,
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatMinutes(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  if (n < 3_600_000) {
    const m = Math.round(n / 60_000);
    return m === 1 ? '1 min' : `${m} min`;
  }
  const h = Math.round(n / 3_600_000);
  return h === 1 ? '1 hr' : `${h} hr`;
}

function formatHour(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return '—';
  const hour = Math.max(0, Math.min(23, Math.floor(n)));
  const suffix = hour >= 12 ? 'pm' : 'am';
  const h12 = hour % 12 || 12;
  return `${h12}${suffix}`;
}

function checklistTriggerSummary(triggers) {
  const parts = [];
  if (triggers.onRestart) parts.push('daemon restart');
  if (triggers.onCycle) parts.push('Tide health cycle');
  if (triggers.onFollowUp) parts.push('Tide follow-up');
  return parts.length ? parts.join(', ') : 'none';
}

/**
 * @param {object} [config] - Root config.json object.
 * @param {{ activeMissionCount?: number }} [opts]
 * @returns {Array<{ id: string, name: string, enabled: boolean, schedule: string, detail?: string }>}
 */
export function listSystemGrounds(config = {}, opts = {}) {
  const tide = config.tide && typeof config.tide === 'object' ? config.tide : {};
  const missions = config.missions && typeof config.missions === 'object' ? config.missions : {};
  const retrospective = getRetrospectiveConfig(config);
  const pulse = {
    ...PULSE_DEFAULTS,
    ...(config.systemPulse && typeof config.systemPulse === 'object' ? config.systemPulse : {}),
  };
  const checklist = normalizeChecklistConfig(tide);

  const tideEnabled = !!tide.enabled;
  const cooldownMinutes = Math.max(1, Number(tide.silenceCooldownMinutes) || Number(tide.intervalMinutes) || 30);
  const healthCheckMinutes = Math.min(
    Math.max(1, Number(tide.healthCheckMinutes) || 7),
    cooldownMinutes,
  );
  const loopMs = Number(missions.loopMs) || 45 * 60_000;
  const curiosityMs = Number(missions.curiosityIntervalMs) || 150 * 60_000;
  const activeMissions = Number(opts.activeMissionCount) || 0;

  const grounds = [
    {
      id: 'cron-runner',
      name: 'Cron runner',
      enabled: true,
      schedule: 'When daemon is running',
      detail: 'Executes scheduled grounds from jobs.json',
    },
    {
      id: 'system-pulse-health',
      name: 'System pulse — health check',
      enabled: pulse.enabled !== false,
      schedule: `Every ${pulse.healthIntervalMinutes != null ? pulse.healthIntervalMinutes : 45} min`,
      detail: 'Log, cron, transport, disk, and LLM reachability checks',
    },
    {
      id: 'system-pulse-patterns',
      name: 'System pulse — output patterns',
      enabled: pulse.enabled !== false,
      schedule: `Every ${pulse.patternIntervalHours != null ? pulse.patternIntervalHours : 8} hr`,
      detail: 'Reviews recent chats and may self-edit SOUL.md or skill docs',
    },
    {
      id: 'tide-followup',
      name: 'Tide — silence follow-up',
      enabled: tideEnabled,
      schedule: `After ${cooldownMinutes} min quiet per chat`,
      detail: tide.inactiveStart && tide.inactiveEnd
        ? `Quiet hours ${tide.inactiveStart}–${tide.inactiveEnd}`
        : 'Proactive check-in after private replies go quiet',
    },
    {
      id: 'tide-health',
      name: 'Tide — health poll',
      enabled: tideEnabled,
      schedule: `Every ${healthCheckMinutes} min`,
      detail: 'Polling watchdog and due Tide follow-ups',
    },
    {
      id: 'tide-checklist',
      name: 'Tide checklist',
      enabled: tideEnabled && checklist.enabled,
      schedule: checklistTriggerSummary(checklist.triggers),
      detail: checklist.items.length
        ? `${checklist.items.filter((it) => it.enabled !== false).length} enabled item(s)`
        : 'No checklist items configured',
    },
    {
      id: 'mission-engine',
      name: 'Mission engine',
      enabled: true,
      schedule: `Every ${formatMinutes(loopMs)}`,
      detail: activeMissions
        ? `${activeMissions} active mission(s) in pasture`
        : 'Ticks due missions when any are active',
    },
    {
      id: 'mission-curiosity',
      name: 'Mission curiosity',
      enabled: activeMissions > 0,
      schedule: `Every ${formatMinutes(curiosityMs)}`,
      detail: activeMissions
        ? 'Idle suggestions for quiet missions'
        : 'Runs only while missions are active',
    },
    {
      id: 'retrospective',
      name: 'Retrospective',
      enabled: retrospective.enabled !== false,
      schedule: `Nightly ${formatHour(retrospective.nightlyHour)}; weekly ${WEEKDAYS[retrospective.weeklyDay] || 'Sun'} ${formatHour(retrospective.weeklyHour)}`,
      detail: 'Batch scoring and reflector lessons (poll every 15 min)',
    },
  ];

  return grounds;
}
