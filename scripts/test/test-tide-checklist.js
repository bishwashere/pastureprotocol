/**
 * Tide checklist unit test: config CRUD + shell run (no daemon).
 * Usage: node scripts/test/test-tide-checklist.js
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addChecklistItem,
  getTideChecklistFromConfig,
  removeChecklistItem,
  runTideChecklist,
  setChecklistEnabled,
  setChecklistTriggers,
} from '../../lib/tide-checklist.js';

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-tide-cl-'));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify(
      {
        tide: {
          enabled: true,
          silenceCooldownMinutes: 30,
          inactiveStart: '23:00',
          inactiveEnd: '06:00',
          checklist: { enabled: true, triggers: { onRestart: true, onCycle: true, onFollowUp: false }, items: [] },
        },
      },
      null,
      2
    ),
    'utf8'
  );
  process.env.COWCODE_STATE_DIR = stateDir;
  return stateDir;
}

async function main() {
  setupStateDir();
  setChecklistEnabled(true);

  const add = addChecklistItem({ label: 'Echo ok', type: 'shell', command: 'echo tide-checklist-ok' });
  if (!add.ok) throw new Error(add.message);

  const items = getTideChecklistFromConfig().items;
  if (items.length !== 1 || items[0].id !== add.id) {
    throw new Error('Expected one checklist item after add');
  }

  setChecklistTriggers({ onFollowUp: true });
  const triggers = getTideChecklistFromConfig().triggers;
  if (!triggers.onFollowUp) throw new Error('onFollowUp trigger not set');

  const summary = await runTideChecklist({ manual: true, trigger: 'manual' });
  if (summary.total !== 1 || summary.passed !== 1) {
    throw new Error(`Expected 1/1 passed, got ${summary.passed}/${summary.total}`);
  }

  const rm = removeChecklistItem(add.id);
  if (!rm.ok) throw new Error(rm.message);
  if (getTideChecklistFromConfig().items.length !== 0) {
    throw new Error('Item should be removed');
  }

  console.log('Tide checklist test passed.');
}

main().catch((e) => {
  console.error('Tide checklist test failed:', e.message);
  process.exit(1);
});
