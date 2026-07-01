/**
 * Cron job store. Persists jobs to cron/jobs.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCronStorePath } from '../lib/util/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_STORE_PATH = getCronStorePath();

/**
 * @typedef {Object} CronScheduleCron
 * @property {'cron'} kind
 * @property {string} expr - Cron expression (e.g. "0 8 * * *" = 08:00 daily)
 * @property {string} [tz] - IANA timezone (e.g. "America/New_York")
 */

/**
 * @typedef {Object} CronScheduleAt
 * @property {'at'} kind
 * @property {string} at - ISO 8601 timestamp (one-shot run at this time)
 */

/** @typedef {CronScheduleCron | CronScheduleAt} CronSchedule */

/**
 * @typedef {Object} CronJob
 * @property {string} id
 * @property {string} name
 * @property {boolean} enabled
 * @property {CronSchedule} schedule
 * @property {string} message - Prompt sent to the LLM
 * @property {string} [jid] - Reply channel: WhatsApp JID or Telegram chat id where the reminder was set up. Reply is sent here by default (even when a separate cron process runs the job).
 * @property {object} [conditional] - Optional deterministic condition for poll-style jobs.
 * @property {number} createdAtMs
 * @property {number} updatedAtMs
 * @property {number} [sentAtMs] - When set, this one-shot was already sent; do not run again (avoids duplicate after restart)
 */

/**
 * @typedef {Object} CronStoreFile
 * @property {number} version
 * @property {CronJob[]} jobs
 */

/**
 * @param {string} [storePath]
 * @returns {CronStoreFile}
 */
export function loadStore(storePath = DEFAULT_STORE_PATH) {
  if (!existsSync(storePath)) {
    const dir = dirname(storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const initial = { version: 1, jobs: [] };
    writeFileSync(storePath, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  const raw = readFileSync(storePath, 'utf8').trim();
  if (!raw) {
    const initial = { version: 1, jobs: [] };
    saveStore(initial, storePath);
    return initial;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const initial = { version: 1, jobs: [] };
    saveStore(initial, storePath);
    return initial;
  }
  if (!Array.isArray(data.jobs)) data.jobs = [];
  return { version: data.version ?? 1, jobs: data.jobs };
}

/**
 * @param {CronStoreFile} store
 * @param {string} [storePath]
 */
export function saveStore(store, storePath = DEFAULT_STORE_PATH) {
  const dir = dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
}

/**
 * @param {string} [storePath]
 * @returns {CronJob[]}
 */
export function loadJobs(storePath = DEFAULT_STORE_PATH) {
  return loadStore(storePath).jobs;
}

/**
 * @param {Omit<CronJob, 'id' | 'createdAtMs' | 'updatedAtMs'>} input
 * @param {string} [storePath]
 * @returns {CronJob}
 */
export function addJob(input, storePath = DEFAULT_STORE_PATH) {
  const store = loadStore(storePath);
  const now = Date.now();
  const id = `job-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    name: input.name ?? 'Unnamed',
    enabled: input.enabled !== false,
    schedule: input.schedule,
    message: input.message ?? '',
    jid: input.jid ?? null,
    conditional: input.conditional && typeof input.conditional === 'object' ? input.conditional : undefined,
    createdAtMs: now,
    updatedAtMs: now,
  };
  store.jobs.push(job);
  saveStore(store, storePath);
  return job;
}

/**
 * @param {string} id
 * @param {Partial<Pick<CronJob, 'name'|'enabled'|'schedule'|'message'|'jid'|'conditional'|'sentAtMs'>>} patch
 * @param {string} [storePath]
 * @returns {CronJob|null}
 */
export function updateJob(id, patch, storePath = DEFAULT_STORE_PATH) {
  const store = loadStore(storePath);
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const job = { ...store.jobs[idx], ...patch, updatedAtMs: Date.now() };
  store.jobs[idx] = job;
  saveStore(store, storePath);
  return job;
}

/**
 * @param {string} id
 * @param {string} [storePath]
 * @returns {boolean}
 */
export function removeJob(id, storePath = DEFAULT_STORE_PATH) {
  const store = loadStore(storePath);
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  store.jobs.splice(idx, 1);
  saveStore(store, storePath);
  return true;
}
