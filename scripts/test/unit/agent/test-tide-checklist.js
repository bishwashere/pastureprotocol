/**
 * Tide checklist: config CRUD + legacy item → prompt normalization (no LLM run).
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  addChecklistItem,
  getTideChecklistFromConfig,
  normalizeChecklistConfig,
  removeChecklistItem,
  setChecklistEnabled,
} from '../../../../lib/agent/tide-checklist.js';

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-tide-cl-'));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify(
      {
        tide: {
          enabled: true,
          checklist: { enabled: true, triggers: { onRestart: true }, items: [] },
        },
      },
      null,
      2
    ),
    'utf8'
  );
  process.env.PASTURE_STATE_DIR = stateDir;
}

async function main() {
  setupStateDir();
  setChecklistEnabled(true);

  const add = addChecklistItem({
    label: 'Time check',
    prompt: 'What is the current local time? Report OK or FAIL.',
  });
  if (!add.ok) throw new Error(add.message);

  const item = getTideChecklistFromConfig().items[0];
  if (!item.prompt.includes('local time')) throw new Error('prompt not stored');

  const legacy = normalizeChecklistConfig({
    checklist: {
      items: [{ id: 'x', label: 'Shell legacy', type: 'shell', command: 'echo hi', enabled: true }],
    },
  });
  if (!legacy.items[0].prompt.includes('echo hi')) {
    throw new Error('legacy shell item should become agent prompt');
  }

  const rm = removeChecklistItem(add.id);
  if (!rm.ok) throw new Error(rm.message);

  console.log('Tide checklist test passed (CRUD + prompt normalization).');
  console.log('Run agent items manually: pasture tide checklist run');
}

main().catch((e) => {
  console.error('Tide checklist test failed:', e.message);
  process.exit(1);
});
