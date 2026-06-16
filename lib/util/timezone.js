/**
 * User timezone and time format for prompts. Reads agents.defaults from config;
 * "auto" means detect from host (IANA) and locale (12/24).
 */

import { readFileSync } from 'fs';
import { getConfigPath } from './paths.js';

/** @type {{ userTimezone?: string, timeFormat?: string }|undefined} */
let cachedDefaults;

function loadAgentsDefaults() {
  if (cachedDefaults !== undefined) return cachedDefaults;
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = raw && raw.trim() ? JSON.parse(raw) : {};
    const agents = config.agents && typeof config.agents === 'object' ? config.agents : {};
    cachedDefaults = agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {};
  } catch {
    cachedDefaults = {};
  }
  return cachedDefaults;
}

/**
 * Resolved IANA timezone. "auto" or missing → host timezone.
 * @returns {string}
 */
export function getResolvedTimezone() {
  const def = loadAgentsDefaults();
  const tz = def?.userTimezone != null ? String(def.userTimezone).trim() : '';
  if (!tz || tz.toLowerCase() === 'auto') {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }
  return tz;
}

/**
 * Resolved time format: "12" | "24". "auto" → detect from default locale.
 * @returns {"12"|"24"}
 */
export function getResolvedTimeFormat() {
  const def = loadAgentsDefaults();
  const fmt = def?.timeFormat != null ? String(def.timeFormat).trim().toLowerCase() : 'auto';
  if (fmt === '12' || fmt === '24') return fmt;
  try {
    const opts = Intl.DateTimeFormat().resolvedOptions();
    const hour12 = opts.hour12;
    if (hour12 === true) return '12';
    if (hour12 === false) return '24';
    const sample = new Intl.DateTimeFormat(opts.locale, { hour: 'numeric' }).formatToParts(new Date());
    const hasAMPM = sample.some((p) => p.type === 'dayPeriod');
    return hasAMPM ? '12' : '24';
  } catch {
    return '12';
  }
}

/**
 * Current time in user timezone, formatted for display.
 * @param {string} [tz] - IANA timezone (default: resolved)
 * @param {"12"|"24"} [timeFormat] - Default: resolved
 * @returns {string}
 */
export function formatCurrentLocalTime(tz, timeFormat) {
  const resolvedTz = tz || getResolvedTimezone();
  const fmt = timeFormat || getResolvedTimeFormat();
  const opts = {
    timeZone: resolvedTz,
    dateStyle: 'short',
    timeStyle: 'short',
    hour12: fmt === '12',
  };
  try {
    return new Date().toLocaleString(undefined, opts);
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Single line to inject into system prompts: user timezone and current local time.
 * All prompts should use this so the model uses the same time context.
 * @returns {string}
 */
export function getTimezoneContextLine() {
  const tz = getResolvedTimezone();
  const timeFormat = getResolvedTimeFormat();
  const localTime = formatCurrentLocalTime(tz, timeFormat);
  return `User's local time: ${localTime} (${tz}). Time format: ${timeFormat}h. Use this for scheduling, reminders, and relative times.`;
}

/**
 * Check if current time in the given timezone is inside the Tide inactive window.
 * Times are 24h "HH:mm". Overnight window: inactiveEnd < inactiveStart (e.g. "06:00" and "23:00").
 * @param {string} inactiveStart - e.g. "23:00" (Tide will not run at or after this)
 * @param {string} inactiveEnd - e.g. "06:00" (Tide will not run before this)
 * @param {string} [tz] - IANA timezone (default: resolved from config)
 * @returns {boolean} true if we are in the inactive window (should skip Tide)
 */
export function isInTideInactiveWindow(inactiveStart, inactiveEnd, tz) {
  if (!inactiveStart || !inactiveEnd) return false;
  const resolvedTz = tz || getResolvedTimezone();
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute').value, 10);
  const currentMins = hour * 60 + minute;

  const parse = (hhmm) => {
    const m = String(hhmm).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const startMins = parse(inactiveStart);
  const endMins = parse(inactiveEnd);
  if (startMins == null || endMins == null) return false;

  if (endMins > startMins) {
    return currentMins >= startMins && currentMins < endMins;
  }
  return currentMins >= startMins || currentMins < endMins;
}

/**
 * Current time as ISO 8601 UTC (for "at" scheduling) and optional local line.
 * @returns {{ nowIso: string, in1min: string, in2min: string, in3min: string, timeContextLine: string }}
 */
export function getSchedulingTimeContext() {
  const now = Date.now();
  return {
    nowIso: new Date(now).toISOString(),
    in1min: new Date(now + 60_000).toISOString(),
    in2min: new Date(now + 120_000).toISOString(),
    in3min: new Date(now + 180_000).toISOString(),
    timeContextLine: getTimezoneContextLine(),
  };
}
