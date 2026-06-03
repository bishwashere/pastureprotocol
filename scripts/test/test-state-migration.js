#!/usr/bin/env node
/**
 * State dir migration: ~/.cowcode → ~/.pasture on first pasture run.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const fakeHome = mkdtempSync(join(tmpdir(), 'pasture-migrate-'));
  const saved = {
    HOME: process.env.HOME,
    PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR,
    COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR,
  };

  try {
    process.env.HOME = fakeHome;
    delete process.env.PASTURE_STATE_DIR;
    delete process.env.COWCODE_STATE_DIR;

    const legacyDir = join(fakeHome, '.cowcode');
    const pastureDir = join(fakeHome, '.pasture');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'config.json'), '{"bio":"legacy"}\n');

    const mod = await import('../../lib/paths.js');
    const migrated = mod.migrateLegacyStateDirIfNeeded();
    assert(migrated === true, 'expected migration to run');
    assert(existsSync(join(pastureDir, 'config.json')), 'pasture config missing');
    assert(readFileSync(join(pastureDir, 'config.json'), 'utf8').includes('legacy'), 'config not copied');
    assert(mod.getStateDir() === pastureDir, 'getStateDir should prefer ~/.pasture after migration');
    assert(existsSync(join(legacyDir, '.migrated-to-pasture')), 'legacy marker missing');
    assert(mod.migrateLegacyStateDirIfNeeded() === false, 'migration must not run twice');

    writeFileSync(join(pastureDir, 'config.json'), '{"bio":"pasture"}\n');
    rmSync(legacyDir, { recursive: true, force: true });
    mkdirSync(join(fakeHome, '.cowcode'), { recursive: true });
    writeFileSync(join(fakeHome, '.cowcode', 'config.json'), '{"bio":"old"}\n');
    assert(mod.migrateLegacyStateDirIfNeeded() === false, 'skip migration when pasture already exists');

    console.log('[PASS] migrateLegacyStateDirIfNeeded copies ~/.cowcode to ~/.pasture once');
    console.log('[PASS] getStateDir uses ~/.pasture after migration');
    console.log('\nAll state migration checks passed.');
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
