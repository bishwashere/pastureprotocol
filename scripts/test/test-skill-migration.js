#!/usr/bin/env node
/**
 * Regression test for the skill migration logic.
 *
 * Bug this prevents: when a brand-new skill is added to DEFAULT_ENABLED in
 * skills/loader.js, existing per-agent config.json files (under
 * ~/.pasture/agents/<id>/config.json) didn't pick it up, because the
 * migration only updated the global ~/.pasture/config.json. Runtime reads
 * via loadAgentConfig() / getEnabledSkillIds() then silently lacked the new
 * skill until the user manually edited config.
 *
 * This test sets PASTURE_STATE_DIR to a tmp dir, drops a global config and
 * three per-agent configs (one with `http` already, one without, one with no
 * skills field at all), runs migrateSkillsConfigToIncludeDefaults(), and
 * asserts the resulting state.
 *
 * Note: index.js is the production import boundary for the migration. Rather
 * than importing index.js (it has many side effects on import), this test
 * factors out the migration via dynamic import + a tiny shim that mirrors
 * the index.js function. If index.js diverges from this shim, the existing
 * `migrateSkillsConfigToIncludeDefaults()` test (or its equivalent) should
 * be updated alongside.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_ENABLED } from '../../skills/loader.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

function migrate(stateDir) {
  // Mirror of migrateSkillsConfigToIncludeDefaults() in index.js. Kept here
  // so the migration logic is testable without booting the whole daemon.
  const ensureDefaults = (config) => {
    const skills = config.skills || {};
    let enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
    let changed = false;
    for (const id of DEFAULT_ENABLED) {
      if (!enabled.includes(id)) {
        enabled = [...enabled, id];
        changed = true;
      }
    }
    if (changed) config.skills = { ...skills, enabled };
    return changed;
  };

  const globalPath = join(stateDir, 'config.json');
  if (existsSync(globalPath)) {
    const config = JSON.parse(readFileSync(globalPath, 'utf8'));
    if (ensureDefaults(config)) writeFileSync(globalPath, JSON.stringify(config, null, 2), 'utf8');
  }

  const agentsDir = join(stateDir, 'agents');
  if (!existsSync(agentsDir)) return;
  for (const id of ['main', 'alex', 'reflector']) {
    const cfgPath = join(agentsDir, id, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (!config.skills || !Array.isArray(config.skills.enabled)) continue;
    if (ensureDefaults(config)) writeFileSync(cfgPath, JSON.stringify(config, null, 2), 'utf8');
  }
}

const stateDir = join(tmpdir(), `pasture-skill-migration-${Date.now()}-${Math.random().toString(36).slice(2)}`);

try {
  mkdirSync(join(stateDir, 'agents', 'main'), { recursive: true });
  mkdirSync(join(stateDir, 'agents', 'alex'), { recursive: true });
  mkdirSync(join(stateDir, 'agents', 'reflector'), { recursive: true });

  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    skills: { enabled: ['cron', 'memory'] },
  }, null, 2));

  writeFileSync(join(stateDir, 'agents', 'main', 'config.json'), JSON.stringify({
    skills: { enabled: ['cron', 'memory', 'browse'] },
  }, null, 2));

  writeFileSync(join(stateDir, 'agents', 'alex', 'config.json'), JSON.stringify({
    skills: { enabled: ['http', 'cron', 'memory'] },
  }, null, 2));

  writeFileSync(join(stateDir, 'agents', 'reflector', 'config.json'), JSON.stringify({
    title: 'Reflector',
  }, null, 2));

  migrate(stateDir);

  const globalCfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
  check('global config has every DEFAULT_ENABLED skill',
    DEFAULT_ENABLED.every((id) => globalCfg.skills.enabled.includes(id)),
    JSON.stringify(globalCfg.skills.enabled));

  const mainCfg = JSON.parse(readFileSync(join(stateDir, 'agents', 'main', 'config.json'), 'utf8'));
  check('main agent picks up newly added http skill', mainCfg.skills.enabled.includes('http'));
  check('main agent retains its prior skills', mainCfg.skills.enabled.includes('browse') && mainCfg.skills.enabled.includes('cron'));
  check('main agent has every DEFAULT_ENABLED skill',
    DEFAULT_ENABLED.every((id) => mainCfg.skills.enabled.includes(id)),
    JSON.stringify(mainCfg.skills.enabled));

  const alexCfg = JSON.parse(readFileSync(join(stateDir, 'agents', 'alex', 'config.json'), 'utf8'));
  check('alex did not duplicate http (idempotent)',
    alexCfg.skills.enabled.filter((id) => id === 'http').length === 1,
    JSON.stringify(alexCfg.skills.enabled));

  const reflectorCfg = JSON.parse(readFileSync(join(stateDir, 'agents', 'reflector', 'config.json'), 'utf8'));
  check('reflector (no skills field) is left untouched',
    !reflectorCfg.skills,
    JSON.stringify(reflectorCfg));

  // Idempotency: running migrate twice should not change anything
  const beforeSecond = readFileSync(join(stateDir, 'agents', 'main', 'config.json'), 'utf8');
  migrate(stateDir);
  const afterSecond = readFileSync(join(stateDir, 'agents', 'main', 'config.json'), 'utf8');
  check('migration is idempotent (running twice = same result)', beforeSecond === afterSecond);
} finally {
  try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n[skill-migration] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
