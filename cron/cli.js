#!/usr/bin/env node
/**
 * CLI to add, list, or remove cron jobs. Jobs run at the given schedule and send the LLM reply to WhatsApp.
 *
 * Usage:
 *   node cron/cli.js list
 *   node cron/cli.js add --name "Morning brief" --cron "0 8 * * *" --message "Summarize today's plan."
 *   node cron/cli.js add --name "Reminder" --cron "0 9 * * 1" --tz "America/New_York" --message "Weekly standup reminder."
 *   node cron/cli.js remove <job-id>
 *
 * Cron expression: 5 fields (min hour day month weekday), e.g. "0 8 * * *" = 08:00 daily.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCronStorePath } from '../lib/util/paths.js';
import { loadJobs, addJob, removeJob, updateJob } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = getCronStorePath();

const args = process.argv.slice(2);
const cmd = args[0];

function parseArg(name, short) {
  const i = args.indexOf('--' + name);
  const is = short != null ? args.indexOf('-' + short) : -1;
  const idx = i >= 0 ? i : is;
  if (idx >= 0 && args[idx + 1] != null) return args[idx + 1];
  return null;
}

function hasFlag(name) {
  return args.includes('--' + name);
}

if (cmd === 'list') {
  const jobs = loadJobs(STORE_PATH);
  if (jobs.length === 0) {
    console.log('No cron jobs. Add one with: node cron/cli.js add --name "..." --cron "0 8 * * *" --message "..."');
    process.exit(0);
  }
  console.log('Cron jobs:');
  for (const j of jobs) {
    const s = j.schedule?.kind === 'cron' ? j.schedule.expr + (j.schedule.tz ? ` (${j.schedule.tz})` : '') : '-';
    console.log(`  ${j.id}  ${j.enabled ? 'on' : 'off'}  ${j.name}  ${s}`);
    console.log(`      message: ${(j.message || '').slice(0, 60)}${(j.message || '').length > 60 ? '…' : ''}`);
  }
  process.exit(0);
}

if (cmd === 'add') {
  const name = parseArg('name', 'n');
  const cronExpr = parseArg('cron', 'c');
  const message = parseArg('message', 'm');
  const tz = parseArg('tz', 't');
  const jid = parseArg('jid', 'j');
  if (!name || !cronExpr || !message) {
    console.error('Usage: node cron/cli.js add --name "Job name" --cron "0 8 * * *" --message "Prompt for the LLM" [--tz America/New_York] [--jid 1234567890@s.whatsapp.net]');
    process.exit(1);
  }
  const job = addJob(
    {
      name,
      enabled: true,
      schedule: { kind: 'cron', expr: cronExpr, tz: tz || undefined },
      message,
      jid: jid || null,
    },
    STORE_PATH
  );
  console.log('Added job:', job.id, job.name);
  process.exit(0);
}

if (cmd === 'remove' || cmd === 'delete') {
  const id = args[1];
  if (!id) {
    console.error('Usage: node cron/cli.js remove <job-id>');
    process.exit(1);
  }
  const ok = removeJob(id, STORE_PATH);
  if (ok) console.log('Removed job:', id);
  else {
    console.error('Job not found:', id);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === 'enable' || cmd === 'disable') {
  const id = args[1];
  if (!id) {
    console.error('Usage: node cron/cli.js enable|disable <job-id>');
    process.exit(1);
  }
  const enabled = cmd === 'enable';
  const job = updateJob(id, { enabled }, STORE_PATH);
  if (job) console.log(job.enabled ? 'Enabled' : 'Disabled', job.name);
  else {
    console.error('Job not found:', id);
    process.exit(1);
  }
  process.exit(0);
}

// no command or unknown
console.log(`Cron CLI. Commands: list, add, remove, enable, disable.`);
console.log(`  list`);
console.log(`  add --name "Name" --cron "0 8 * * *" --message "Prompt" [--tz America/New_York] [--jid JID]`);
console.log(`  remove <job-id>`);
console.log(`  enable|disable <job-id>`);
process.exit(cmd ? 1 : 0);
