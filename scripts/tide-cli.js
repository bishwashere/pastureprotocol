#!/usr/bin/env node
/**
 * Tide checklist CLI: cowcode tide checklist ...
 *   list | add | remove | enable | disable | run | triggers
 */

import {
  addChecklistItem,
  getTideChecklistFromConfig,
  listChecklistItems,
  readLastChecklistRun,
  removeChecklistItem,
  runTideChecklist,
  setChecklistEnabled,
  setChecklistItemEnabled,
  setChecklistTriggers,
} from '../lib/tide-checklist.js';

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shell' && argv[i + 1]) {
      flags.type = 'shell';
      flags.command = argv[++i];
    } else if (argv[i] === '--http' && argv[i + 1]) {
      flags.type = 'http';
      flags.url = argv[++i];
    } else if (argv[i] === '--url' && argv[i + 1]) {
      flags.url = argv[++i];
    } else if (argv[i] === '--path' && argv[i + 1]) {
      flags.type = 'file_exists';
      flags.path = argv[++i];
    } else if (argv[i] === '--builtin' && argv[i + 1]) {
      flags.type = 'builtin';
      flags.builtin = argv[++i];
    } else if (argv[i] === '--expect-status' && argv[i + 1]) {
      flags.expectStatus = Number(argv[++i]);
    } else if (argv[i] === '--on-restart') flags.onRestart = true;
    else if (argv[i] === '--no-on-restart') flags.onRestart = false;
    else if (argv[i] === '--on-cycle') flags.onCycle = true;
    else if (argv[i] === '--no-on-cycle') flags.onCycle = false;
    else if (argv[i] === '--on-follow-up') flags.onFollowUp = true;
    else if (argv[i] === '--no-on-follow-up') flags.onFollowUp = false;
    else if (argv[i] === '--enable-checklist') setChecklistEnabled(true);
    else if (argv[i] === '--disable-checklist') setChecklistEnabled(false);
  }
  return flags;
}

function printUsage() {
  console.log('Tide checklist commands:');
  console.log('  cowcode tide checklist list');
  console.log('  cowcode tide checklist add <label> --shell "<command>"');
  console.log('  cowcode tide checklist add <label> --http <url> [--expect-status 200]');
  console.log('  cowcode tide checklist add <label> --path <file>');
  console.log('  cowcode tide checklist add <label> --builtin telegram_polling');
  console.log('  cowcode tide checklist remove <id>');
  console.log('  cowcode tide checklist enable <id>');
  console.log('  cowcode tide checklist disable <id>');
  console.log('  cowcode tide checklist run [--id <id>]');
  console.log('  cowcode tide checklist triggers [--on-restart] [--no-on-cycle] [--on-follow-up] ...');
  console.log('  cowcode tide checklist on|off           (checklist master switch)');
  console.log('');
  console.log('Requires tide.enabled in config for automatic runs on restart/cycle/follow-up.');
}

function printList() {
  const checklist = getTideChecklistFromConfig();
  console.log('Checklist:', checklist.enabled ? 'enabled' : 'disabled');
  console.log('Triggers:', JSON.stringify(checklist.triggers));
  const items = listChecklistItems();
  if (!items.length) {
    console.log('No items. Add one with: cowcode tide checklist add "My check" --shell "echo ok"');
    return;
  }
  console.log('');
  for (const it of items) {
    const status = it.enabled ? 'on' : 'off';
    const extra =
      it.type === 'shell'
        ? it.command
        : it.type === 'http'
          ? it.url
          : it.type === 'file_exists'
            ? it.path
            : it.builtin || it.type;
    console.log(`  [${status}] ${it.id} — ${it.label} (${it.type}: ${extra || '—'})`);
  }
  const last = readLastChecklistRun();
  if (last?.at) {
    console.log('');
    console.log(`Last run: ${last.at} — ${last.passed}/${last.total} passed (${last.trigger || '?'})`);
  }
}

async function main() {
  let argv = process.argv.slice(2);
  if ((argv[0] || '').toLowerCase() === 'checklist') argv = argv.slice(1);
  const sub = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);

  if (!sub || sub === 'help') {
    printUsage();
    process.exit(sub ? 0 : 0);
  }

  if (sub === 'list') {
    printList();
    return;
  }

  if (sub === 'enable' && rest[0] !== 'checklist') {
    const r = setChecklistItemEnabled(rest[0], true);
    console.log(r.ok ? r.message : 'Error: ' + r.message);
    process.exit(r.ok ? 0 : 1);
    return;
  }

  if (sub === 'disable' && rest[0] !== 'checklist') {
    const r = setChecklistItemEnabled(rest[0], false);
    console.log(r.ok ? r.message : 'Error: ' + r.message);
    process.exit(r.ok ? 0 : 1);
    return;
  }

  if (sub === 'on') {
    setChecklistEnabled(true);
    console.log('Tide checklist enabled.');
    return;
  }

  if (sub === 'off') {
    setChecklistEnabled(false);
    console.log('Tide checklist disabled.');
    return;
  }

  if (sub === 'remove') {
    const r = removeChecklistItem(rest[0]);
    console.log(r.ok ? r.message : 'Error: ' + r.message);
    process.exit(r.ok ? 0 : 1);
    return;
  }

  if (sub === 'add') {
    const labelParts = [];
    let i = 0;
    while (i < rest.length && !rest[i].startsWith('--')) {
      labelParts.push(rest[i]);
      i += 1;
    }
    const label = labelParts.join(' ').trim();
    const flags = parseFlags(rest.slice(i));
    const r = addChecklistItem({ label, ...flags });
    console.log(r.ok ? r.message : 'Error: ' + r.message);
    process.exit(r.ok ? 0 : 1);
    return;
  }

  if (sub === 'triggers') {
    const flags = parseFlags(rest);
    const patch = {};
    if (flags.onRestart !== undefined) patch.onRestart = flags.onRestart;
    if (flags.onCycle !== undefined) patch.onCycle = flags.onCycle;
    if (flags.onFollowUp !== undefined) patch.onFollowUp = flags.onFollowUp;
    if (!Object.keys(patch).length) {
      const cl = getTideChecklistFromConfig();
      console.log('Triggers:', JSON.stringify(cl.triggers, null, 2));
      console.log('Set with: cowcode tide checklist triggers --on-restart --on-cycle --no-on-follow-up');
      return;
    }
    const r = setChecklistTriggers(patch);
    console.log('Updated triggers:', JSON.stringify(r.triggers));
    return;
  }

  if (sub === 'run') {
    const onlyIds = [];
    for (let j = 0; j < rest.length; j++) {
      if (rest[j] === '--id' && rest[j + 1]) {
        onlyIds.push(rest[++j]);
      }
    }
    const summary = await runTideChecklist({ manual: true, trigger: 'manual', onlyIds: onlyIds.length ? onlyIds : undefined });
    for (const r of summary.results || []) {
      console.log((r.ok ? '✓' : '✗') + ' ' + r.id + ' — ' + r.label + ': ' + r.detail);
    }
    console.log('');
    console.log(summary.passed + '/' + summary.total + ' passed');
    process.exit(summary.failed > 0 ? 1 : 0);
    return;
  }

  console.log('Unknown subcommand:', sub);
  printUsage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
