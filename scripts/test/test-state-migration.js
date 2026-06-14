#!/usr/bin/env node
/**
 * State dir: verify getStateDir() resolves to ~/.pasture (or PASTURE_STATE_DIR override).
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const fakeHome = mkdtempSync(join(tmpdir(), 'pasture-state-'));
  const saved = {
    HOME: process.env.HOME,
    PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR,
  };

  try {
    process.env.HOME = fakeHome;
    delete process.env.PASTURE_STATE_DIR;

    const mod = await import('../../lib/paths.js');

    const expected = join(fakeHome, '.pasture');
    assert(mod.getStateDir() === expected, `getStateDir should return ~/.pasture, got ${mod.getStateDir()}`);
    console.log('[PASS] getStateDir returns ~/.pasture by default');

    const custom = join(fakeHome, 'custom-state');
    process.env.PASTURE_STATE_DIR = custom;
    assert(mod.getStateDir() === custom, `getStateDir should respect PASTURE_STATE_DIR override`);
    console.log('[PASS] getStateDir respects PASTURE_STATE_DIR override');

    console.log('\nAll state dir checks passed.');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
