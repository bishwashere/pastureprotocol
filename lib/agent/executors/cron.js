/**
 * Cron executor: runs add / list / remove from LLM-provided args.
 * No skill .js logic; parameters come from tools.json + config.
 * After addJob succeeds, returns confirmation (reminders live in cron/jobs.json only).
 */

import { addJob, loadJobs, removeJob } from '../../../cron/store.js';

function parseAbsoluteTimeMs(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Always persist one-shot "at" as exact ISO 8601. Parse any parseable input and store as ISO. */
function coerceSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return null;
  const rawKind = (schedule.kind && String(schedule.kind).trim().toLowerCase()) || '';
  const atRaw = schedule.at;
  const atString = typeof atRaw === 'string' ? atRaw.trim() : '';
  const parsedMs = atString ? parseAbsoluteTimeMs(atString) : null;
  const kind = rawKind === 'at' || rawKind === 'cron' ? rawKind : (schedule.expr ? 'cron' : atString ? 'at' : null);
  if (!kind) return null;
  const next = { kind };
  if (kind === 'at') {
    if (!atString) return null;
    if (parsedMs == null || !Number.isFinite(parsedMs)) {
      throw new Error('One-shot time must be a valid ISO 8601 timestamp (e.g. 2026-02-19T14:30:00.000Z). Got: ' + atString.slice(0, 60));
    }
    next.at = new Date(parsedMs).toISOString();
  }
  if (kind === 'cron') {
    if (schedule.expr && String(schedule.expr).trim()) next.expr = String(schedule.expr).trim();
    if (schedule.tz && String(schedule.tz).trim()) next.tz = String(schedule.tz).trim();
  }
  return next;
}

/** By default attach reply to the same channel (ctx.jid) where the reminder was set up; separate cron processes still send to this jid. */
function normalizeJobAdd(raw, jid) {
  const job = typeof raw === 'object' && raw !== null ? raw : {};
  const message = (job.message && String(job.message).trim()) || (job.text && String(job.text).trim()) || 'Reminder';
  const schedule = coerceSchedule(job.schedule);
  if (!schedule) throw new Error('job.schedule required (e.g. { "kind": "at", "at": "<ISO8601>" } or { "kind": "cron", "expr": "0 8 * * *" })');
  const name = (job.name && String(job.name).trim()) || 'Reminder';
  return { name, enabled: true, schedule, message, jid: jid || null };
}

function formatJobList(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.length === 0) return "You don't have any scheduled jobs. Use action add to create one.";
  const lines = list.map((j, i) => {
    let when = '';
    if (j.schedule?.kind === 'at' && j.schedule?.at) {
      try {
        when = new Date(j.schedule.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
      } catch {
        when = j.schedule.at;
      }
    } else if (j.schedule?.kind === 'cron' && j.schedule?.expr) {
      when = `cron ${j.schedule.expr}` + (j.schedule.tz ? ` (${j.schedule.tz})` : '');
    } else when = 'scheduled';
    const msg = (j.message || '').slice(0, 40) + ((j.message || '').length > 40 ? '…' : '');
    return `${i + 1}. id=${j.id} — ${when} — "${msg}"`;
  });
  return `Scheduled jobs (${list.length}):\n${lines.join('\n')}`;
}

/**
 * @param {object} ctx - { storePath, jid, scheduleOneShot, startCron }
 * @param {object} args - LLM tool args (action, job?, jobId?)
 */
export async function executeCron(ctx, args) {
  const { storePath, jid, scheduleOneShot, startCron } = ctx;
  const action = args?.action && String(args.action).trim().toLowerCase();
  if (!action) throw new Error('action required (add, list, remove)');

  if (action === 'list') {
    return formatJobList(loadJobs(storePath));
  }

  if (action === 'remove') {
    const raw = args.jobId && String(args.jobId).trim();
    if (!raw) throw new Error('jobId required for remove');
    // Accept either a real job id OR a 1-based position number (e.g. "2" when user says "remove 2").
    let jobId = raw;
    if (/^\d+$/.test(raw)) {
      const pos = parseInt(raw, 10);
      const jobs = loadJobs(storePath);
      const job = jobs[pos - 1];
      if (!job) throw new Error(`Position ${pos} is out of range (only ${jobs.length} job${jobs.length === 1 ? '' : 's'}). Call cron_list first.`);
      jobId = job.id;
    }
    const removed = removeJob(jobId, storePath);
    if (removed && typeof startCron === 'function') startCron();
    if (!removed) return `Job ${jobId} not found. Call cron_list to see current job IDs.`;
    const remaining = loadJobs(storePath);
    return remaining.length === 0
      ? `Removed ${jobId}. No jobs remaining.`
      : `Removed ${jobId}. ${formatJobList(remaining)}`;
  }

  if (action === 'add') {
    const input = normalizeJobAdd(args.job, jid);
    if (input.schedule?.kind === 'at' && input.schedule?.at) {
      const atMs = new Date(input.schedule.at).getTime();
      if (!Number.isFinite(atMs) || atMs <= Date.now()) {
        throw new Error('One-shot "at" time must be in the future. Use a future ISO 8601 timestamp.');
      }
      const existing = loadJobs(storePath);
      const duplicate = existing.some(
        (j) =>
          j.schedule?.kind === 'at' &&
          j.schedule?.at === input.schedule?.at &&
          (j.jid || null) === (input.jid || null) &&
          (j.message || '') === (input.message || '')
      );
      if (duplicate) {
        const when = new Date(input.schedule.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
        return `Scheduled: "${(input.message || '').slice(0, 50)}${(input.message || '').length > 50 ? '…' : ''}" at ${when}.`;
      }
    }
    const job = addJob(input, storePath);
    if (job.schedule?.kind === 'at') {
      scheduleOneShot(job);
    } else if (job.schedule?.kind === 'cron' && typeof startCron === 'function') {
      startCron();
    }
    const when = job.schedule?.kind === 'at' && job.schedule?.at
      ? new Date(job.schedule.at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
      : job.schedule?.kind === 'cron'
        ? (job.schedule?.expr || 'cron') + (job.schedule?.tz ? ` (${job.schedule.tz})` : '')
        : 'scheduled';
    return `Scheduled: "${(job.message || '').slice(0, 50)}${(job.message || '').length > 50 ? '…' : ''}" at ${when}.`;
  }

  throw new Error(`Unknown action: ${action}`);
}
