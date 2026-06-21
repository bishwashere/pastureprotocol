/**
 * System crons — daemon schedules shown like crontab -l on the dashboard.
 * Only entries whose feature/skill is enabled in Pasture are returned.
 */

import { getRetrospectiveConfig } from '../agent/retrospective.js';
import { normalizeChecklistConfig } from '../agent/tide-checklist.js';

const PULSE_DEFAULTS = {
  enabled: true,
  healthIntervalMinutes: 45,
  patternIntervalHours: 8,
};

/** @typedef {{ id: string, name: string, feature: string, skillId?: string|null, expr: string, detail?: string, enabled?: boolean }} SystemCronEntry */

/**
 * Map minute interval to a 5-field cron expression when possible.
 * @param {number} minutes
 */
export function everyMinutesToCron(minutes) {
  const m = Math.max(1, Math.floor(Number(minutes) || 1));
  if (m <= 59) return `*/${m} * * * *`;
  if (m % 60 === 0) {
    const h = m / 60;
    if (h >= 1 && h <= 23) return `0 */${h} * * *`;
  }
  return `@every ${m}m`;
}

function atHourCron(hour) {
  const h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
  return `0 ${h} * * *`;
}

function weeklyCron(day, hour) {
  const d = Math.max(0, Math.min(6, Math.floor(Number(day) || 0)));
  const h = Math.max(0, Math.min(23, Math.floor(Number(hour) || 0)));
  return `0 ${h} * * ${d}`;
}

function msToMinutes(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 45;
  return Math.max(1, Math.round(n / 60_000));
}

function resolveEnabledSkills(config = {}, opts = {}) {
  if (Array.isArray(opts.enabledSkills)) return opts.enabledSkills;
  const raw = config.skills?.enabled;
  return Array.isArray(raw) ? raw : [];
}

function isSkillEnabled(skillId, enabledSkills) {
  if (!skillId) return true;
  return enabledSkills.includes(skillId);
}

/**
 * Build all candidate system cron lines (before feature/skill filtering).
 * @param {object} config
 * @param {{ activeMissionCount?: number }} opts
 * @returns {SystemCronEntry[]}
 */
export function buildSystemCronEntries(config = {}, opts = {}) {
  const tide = config.tide && typeof config.tide === 'object' ? config.tide : {};
  const missionsCfg = config.missions && typeof config.missions === 'object' ? config.missions : {};
  const retrospective = getRetrospectiveConfig(config);
  const pulse = {
    ...PULSE_DEFAULTS,
    ...(config.systemPulse && typeof config.systemPulse === 'object' ? config.systemPulse : {}),
  };
  const checklist = normalizeChecklistConfig(tide);

  const tideEnabled = !!tide.enabled;
  const pulseEnabled = pulse.enabled !== false;
  const retroEnabled = retrospective.enabled !== false;
  const cooldownMinutes = Math.max(1, Number(tide.silenceCooldownMinutes) || Number(tide.intervalMinutes) || 30);
  const healthCheckMinutes = Math.min(
    Math.max(1, Number(tide.healthCheckMinutes) || 7),
    cooldownMinutes,
  );
  const loopMinutes = msToMinutes(missionsCfg.loopMs || 45 * 60_000);
  const curiosityMinutes = msToMinutes(missionsCfg.curiosityIntervalMs || 150 * 60_000);
  const activeMissions = Number(opts.activeMissionCount) || 0;

  /** @type {SystemCronEntry[]} */
  const entries = [];

  if (pulseEnabled) {
    const healthMin = pulse.healthIntervalMinutes != null ? pulse.healthIntervalMinutes : 45;
    entries.push({
      id: 'system-pulse-health',
      name: 'system-pulse health',
      feature: 'system-pulse',
      expr: everyMinutesToCron(healthMin),
      detail: 'Log, cron, transport, disk, and LLM reachability checks',
      enabled: true,
    });
    const patternHours = pulse.patternIntervalHours != null ? pulse.patternIntervalHours : 8;
    entries.push({
      id: 'system-pulse-patterns',
      name: 'system-pulse patterns',
      feature: 'system-pulse',
      expr: `0 */${Math.max(1, Math.floor(Number(patternHours) || 8))} * * *`,
      detail: 'Reviews recent chats; may self-edit SOUL.md or skill docs',
      enabled: true,
    });
  }

  if (tideEnabled) {
    entries.push({
      id: 'tide-health',
      name: 'tide poll',
      feature: 'tide',
      expr: everyMinutesToCron(healthCheckMinutes),
      detail: 'Polling watchdog and due Tide follow-ups',
      enabled: true,
    });
    entries.push({
      id: 'tide-followup',
      name: 'tide follow-up',
      feature: 'tide',
      expr: `@after ${cooldownMinutes}m quiet`,
      detail: tide.inactiveStart && tide.inactiveEnd
        ? `Per chat; quiet hours ${tide.inactiveStart}–${tide.inactiveEnd}`
        : 'Per chat after private replies go quiet',
      enabled: true,
    });
    if (checklist.enabled) {
      if (checklist.triggers.onRestart) {
        entries.push({
          id: 'tide-checklist-reboot',
          name: 'tide-checklist',
          feature: 'tide',
          expr: '@reboot',
          detail: checklist.items.length
            ? `${checklist.items.filter((it) => it.enabled !== false).length} checklist item(s)`
            : 'No checklist items configured',
          enabled: true,
        });
      }
      if (checklist.triggers.onCycle) {
        entries.push({
          id: 'tide-checklist-cycle',
          name: 'tide-checklist',
          feature: 'tide',
          expr: everyMinutesToCron(healthCheckMinutes),
          detail: 'Runs on Tide health cycle',
          enabled: true,
        });
      }
      if (checklist.triggers.onFollowUp) {
        entries.push({
          id: 'tide-checklist-followup',
          name: 'tide-checklist',
          feature: 'tide',
          expr: '@tide-follow-up',
          detail: 'Runs after each Tide follow-up',
          enabled: true,
        });
      }
    }
  }

  entries.push({
    id: 'mission-engine',
    name: 'mission-engine tick',
    feature: 'missions',
    expr: everyMinutesToCron(loopMinutes),
    detail: activeMissions
      ? `${activeMissions} active mission(s)`
      : 'Ticks due missions when any are active',
    enabled: true,
  });

  if (activeMissions > 0) {
    entries.push({
      id: 'mission-curiosity',
      name: 'mission curiosity',
      feature: 'missions',
      expr: everyMinutesToCron(curiosityMinutes),
      detail: 'Idle suggestions for quiet missions',
      enabled: true,
    });
  }

  if (retroEnabled) {
    entries.push({
      id: 'retrospective-nightly',
      name: 'retrospective nightly',
      feature: 'retrospective',
      expr: atHourCron(retrospective.nightlyHour),
      detail: 'Batch scoring and reflector lessons',
      enabled: true,
    });
    entries.push({
      id: 'retrospective-weekly',
      name: 'retrospective weekly',
      feature: 'retrospective',
      expr: weeklyCron(retrospective.weeklyDay, retrospective.weeklyHour),
      detail: 'Weekly reflection pass (scheduler polls every 15 min)',
      enabled: true,
    });
  }

  // Cron skill enabled → show that jobs.json reminders are executed by the daemon cron runner.
  if (isSkillEnabled('cron', resolveEnabledSkills(config, opts))) {
    entries.push({
      id: 'cron-runner',
      name: 'cron runner',
      feature: 'cron',
      skillId: 'cron',
      expr: '# jobs.json',
      detail: 'Executes scheduled crons when the daemon is running',
      enabled: true,
    });
  }

  return entries;
}

/**
 * Visible system crons for the dashboard (enabled features/skills only).
 * @param {object} [config]
 * @param {{ activeMissionCount?: number, enabledSkills?: string[] }} [opts]
 */
export function listSystemCrons(config = {}, opts = {}) {
  return buildSystemCronEntries(config, opts).filter((entry) => entry.enabled !== false);
}
