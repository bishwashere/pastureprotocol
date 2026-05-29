/**
 * Calendar executor: semantically named Google Calendar actions backed by the gog CLI.
 * Translates structured args → gog argv, then delegates to the gog spawn logic.
 * Actions: list_events, get_event, create_event, update_event, delete_event,
 *          check_availability, find_free_slot.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { getConfigPath } from '../paths.js';

const MAX_OUTPUT_CHARS = 16_000;

function truncate(text) {
  if (!text) return '';
  const s = text.trim();
  return s.length <= MAX_OUTPUT_CHARS ? s : s.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)';
}

function getDefaultAccount() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const account = config?.skills?.gog?.account || config?.skills?.calendar?.account;
    if (account && typeof account === 'string' && account.trim()) return account.trim();
    if (process.env.GOG_ACCOUNT) return process.env.GOG_ACCOUNT;
  } catch (_) {}
  return '';
}

function runGog(argv, account, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    const pathSep = process.platform === 'win32' ? ';' : ':';
    env.PATH = ['/opt/homebrew/bin', '/usr/local/bin'].join(pathSep) + pathSep + (env.PATH || '');
    const acc = account || getDefaultAccount();
    if (acc) env.GOG_ACCOUNT = acc;
    const child = spawn('gog', argv, { cwd: cwd || process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { if (stdout.length < MAX_OUTPUT_CHARS) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_OUTPUT_CHARS) stderr += c; });
    child.on('error', (err) => resolve(JSON.stringify({ error: err.message })));
    child.on('close', (code) => {
      const out = truncate(stdout);
      const err = truncate(stderr);
      if (code === 0) { resolve(out || err || 'OK'); return; }
      resolve(JSON.stringify({ error: err || out || `gog exited ${code}` }));
    });
  });
}

/**
 * Parse a duration string like "30min", "1h", "90min", "2h30m" → minutes.
 */
function parseDurationMinutes(s) {
  if (!s || typeof s !== 'string') return 60;
  const hours = (s.match(/(\d+(?:\.\d+)?)\s*h/i) || [])[1];
  const mins = (s.match(/(\d+)\s*m(?:in)?/i) || [])[1];
  return Math.round((Number(hours || 0) * 60) + Number(mins || 0)) || 60;
}

/**
 * Add minutes to an ISO datetime string.
 */
function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * @param {object} ctx
 * @param {object} args
 * @param {string} toolName - e.g. calendar_list_events
 */
export async function executeCalendar(ctx, args, toolName) {
  const action = (toolName || '').replace(/^calendar_/, '') || (args?.action && String(args.action).trim());
  if (!action) return JSON.stringify({ error: 'action required' });

  const account = args?.account?.trim() || '';
  const cwd = ctx?.workspaceDir || process.cwd();
  const calendar = args?.calendar?.trim() || '';

  switch (action) {

    case 'list_events': {
      const days = Math.min(365, Math.max(1, Number(args?.days) || 7));
      const max = Math.min(200, Math.max(1, Number(args?.max) || 20));
      const query = args?.query?.trim() || '';
      const now = new Date().toISOString();
      const until = new Date(Date.now() + days * 86_400_000).toISOString();
      const argv = [
        'calendar', 'list',
        '--from', now,
        '--to', until,
        '--max', String(max),
        ...(query ? ['--search', query] : []),
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'get_event': {
      const eventId = args?.event_id?.trim();
      if (!eventId) return JSON.stringify({ error: 'event_id required' });
      const argv = [
        'calendar', 'get', eventId,
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'create_event': {
      if (args?.confirm !== true) {
        return JSON.stringify({ error: 'Confirmation required. Ask the user to confirm before creating a calendar event. Set confirm: true to proceed.' });
      }
      const title = args?.title?.trim();
      const start = args?.start?.trim();
      if (!title) return JSON.stringify({ error: 'title required' });
      if (!start) return JSON.stringify({ error: 'start datetime required' });

      let end = args?.end?.trim() || '';
      // If end looks like a duration, compute from start
      if (end && /^\d+\s*(?:h|m(?:in)?)/i.test(end)) {
        try {
          const startMs = new Date(start).getTime();
          if (!isNaN(startMs)) {
            end = addMinutes(new Date(start).toISOString(), parseDurationMinutes(end));
          }
        } catch (_) {}
      }
      if (!end) {
        try {
          end = addMinutes(new Date(start).toISOString(), 60);
        } catch (_) {}
      }

      const argv = [
        'calendar', 'create',
        '--title', title,
        '--start', start,
        ...(end ? ['--end', end] : []),
        ...(args?.description?.trim() ? ['--description', args.description.trim()] : []),
        ...(args?.attendees?.trim() ? ['--attendees', args.attendees.trim()] : []),
        ...(args?.location?.trim() ? ['--location', args.location.trim()] : []),
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'update_event': {
      if (args?.confirm !== true) {
        return JSON.stringify({ error: 'Confirmation required. Set confirm: true to proceed.' });
      }
      const eventId = args?.event_id?.trim();
      if (!eventId) return JSON.stringify({ error: 'event_id required' });
      const argv = [
        'calendar', 'update', eventId,
        ...(args?.title?.trim() ? ['--title', args.title.trim()] : []),
        ...(args?.start?.trim() ? ['--start', args.start.trim()] : []),
        ...(args?.end?.trim() ? ['--end', args.end.trim()] : []),
        ...(args?.description?.trim() ? ['--description', args.description.trim()] : []),
        ...(args?.location?.trim() ? ['--location', args.location.trim()] : []),
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'delete_event': {
      if (args?.confirm !== true) {
        return JSON.stringify({ error: 'Confirmation required. Set confirm: true to actually delete the event.' });
      }
      const eventId = args?.event_id?.trim();
      if (!eventId) return JSON.stringify({ error: 'event_id required' });
      const argv = [
        'calendar', 'delete', eventId,
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'check_availability': {
      const start = args?.start?.trim();
      const end = args?.end?.trim();
      if (!start || !end) return JSON.stringify({ error: 'start and end are required' });
      const attendees = args?.attendees?.trim() || '';
      const argv = [
        'calendar', 'freebusy',
        '--from', start,
        '--to', end,
        ...(attendees ? ['--attendees', attendees] : []),
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    case 'find_free_slot': {
      const duration = args?.duration?.trim() || '1h';
      const durationMins = parseDurationMinutes(duration);
      const from = args?.from?.trim() || new Date().toISOString();
      const until = args?.until?.trim() || addMinutes(new Date().toISOString(), 7 * 24 * 60);
      const businessHours = args?.business_hours_only !== false;
      const argv = [
        'calendar', 'find-slot',
        '--duration', String(durationMins),
        '--from', from,
        '--to', until,
        ...(businessHours ? ['--business-hours'] : []),
        ...(calendar ? ['--calendar', calendar] : []),
        '--json', '--no-input',
      ];
      return runGog(argv, account, cwd);
    }

    default:
      return JSON.stringify({ error: `Unknown Calendar action: ${action}` });
  }
}
