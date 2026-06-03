#!/usr/bin/env node
/**
 * Tide checklist CLI: pasture tide checklist ...
 *   list | add | remove | enable | disable | run | triggers
 * Each checklist item runs as an agent turn (same LLM/tools path as chat).
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
    if (argv[i] === '--prompt' && argv[i + 1]) {
      flags.prompt = argv[++i];
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
  console.log('Tide checklist commands (each item = one agent/LLM turn with full skills):');
  console.log('  pasture tide checklist list');
  console.log('  pasture tide checklist add <label> [--prompt "what to check"]');
  console.log('  pasture tide checklist remove <id>');
  console.log('  pasture tide checklist enable <id>');
  console.log('  pasture tide checklist disable <id>');
  console.log('  pasture tide checklist run [--id <id>]');
  console.log('  pasture tide checklist triggers [--on-restart] [--no-on-cycle] [--on-follow-up] ...');
  console.log('  pasture tide checklist on|off');
  console.log('');
  console.log('Requires tide.enabled for automatic runs. Items run one-by-one in order.');
}

function printList() {
  const checklist = getTideChecklistFromConfig();
  console.log('Checklist:', checklist.enabled ? 'enabled' : 'disabled');
  console.log('Triggers:', JSON.stringify(checklist.triggers));
  const items = listChecklistItems();
  if (!items.length) {
    console.log('No items. Example: pasture tide checklist add "Time check" --prompt "What time is it locally?"');
    return;
  }
  console.log('');
  for (const it of items) {
    const status = it.enabled ? 'on' : 'off';
    console.log(`  [${status}] ${it.id} — ${it.label}`);
    console.log(`         prompt: ${(it.prompt || '').slice(0, 100)}${(it.prompt || '').length > 100 ? '…' : ''}`);
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
    const r = addChecklistItem({ label, prompt: flags.prompt, ...flags });
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
      return;
    }
    const r = setChecklistTriggers(patch);
    console.log('Updated triggers:', JSON.stringify(r.triggers));
    return;
  }

  if (sub === 'run') {
    const onlyIds = [];
    for (let j = 0; j < rest.length; j++) {
      if (rest[j] === '--id' && rest[j + 1]) onlyIds.push(rest[++j]);
    }
    const summary = await runTideChecklist({ manual: true, trigger: 'manual', onlyIds: onlyIds.length ? onlyIds : undefined });
    for (const r of summary.results || []) {
      console.log((r.ok ? '✓' : '✗') + ' ' + r.id + ' — ' + (r.detail || '').slice(0, 200));
      if (r.skillsCalled?.length) console.log('   skills:', r.skillsCalled.join(', '));
    }
    console.log('');
    console.log((summary.passed ?? 0) + '/' + (summary.total ?? 0) + ' passed');
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
