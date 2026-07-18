#!/usr/bin/env node
/**
 * Unit tests for the exec skill.
 */

import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDirDefault = join(tmpdir(), `pasture-exec-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const stateDirEnabled = join(tmpdir(), `pasture-exec-enabled-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const workspaceDir = join(stateDirEnabled, 'workspace');

  try {
    process.env.PASTURE_STATE_DIR = stateDirDefault;
    const loader = await import('../../../../skills/loader.js');
    assert(!loader.DEFAULT_ENABLED.includes('exec'), 'exec must not be in DEFAULT_ENABLED');
    assert(!loader.getEnabledSkillIds().includes('exec'), 'exec must be disabled when config is missing');

    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(stateDirEnabled, 'config.json'), JSON.stringify({
      skills: {
        enabled: ['exec', 'go-read'],
        exec: {
          mode: 'allowlist',
          allowlist: ['node'],
          timeoutMs: 30_000,
        },
      },
    }, null, 2));

    process.env.PASTURE_STATE_DIR = stateDirEnabled;
    assert(loader.getEnabledSkillIds().includes('exec'), 'exec should be exposed when explicitly enabled');

    const skillContext = loader.getSkillContext({ hintSkills: ['exec'] });
    const execTool = skillContext.runSkillTool.find((tool) => tool?.function?.name === 'exec_run');
    assert(execTool, 'exec_run tool should be built from SKILL.md');
    const required = execTool.function.parameters.required || [];
    assert(required.includes('command'), 'exec_run requires command');
    assert(required.includes('argv'), 'exec_run requires argv');
    assert(!required.includes('cwd'), 'exec_run cwd should be optional');
    assert(!required.includes('timeoutMs'), 'exec_run timeoutMs should be optional');
    assert(!required.includes('env'), 'exec_run env should be optional');

    const { executeSkill } = await import('../../../../skills/executor.js');
    const version = await executeSkill('exec', { workspaceDir }, { command: 'node', argv: ['--version'] }, 'exec_run');
    assert(/^v\d+\.\d+\.\d+/.test(version.trim()), `expected node version, got ${version}`);

    const denied = JSON.parse(await executeSkill('exec', { workspaceDir }, { command: 'sh', argv: ['-c', 'echo nope'] }, 'exec_run'));
    assert(/not allowlisted/i.test(denied.error || ''), `expected allowlist denial, got ${JSON.stringify(denied)}`);

    console.log('Exec skill test passed.');
  } finally {
    try { rmSync(stateDirDefault, { recursive: true, force: true }); } catch (_) {}
    try { rmSync(stateDirEnabled, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
