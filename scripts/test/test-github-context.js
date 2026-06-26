#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-gh-ctx-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ skills: { enabled: ['github', 'read', 'go-read'] } }),
    'utf8',
  );
  writeFileSync(join(stateDir, 'secrets.json'), JSON.stringify({ github: { token: 'ghp_test' } }), 'utf8');

  try {
    const {
      hasGithubToken,
      buildGithubSourceIntentPlan,
      getGithubSystemPromptBlock,
    } = await import('../../lib/context/github-context.js');
    const { getEnabledSkillIds } = await import('../../skills/loader.js');

    assert(hasGithubToken(), 'token detected');

    const block = getGithubSystemPromptBlock();
    assert(block.includes('Never tell the user you lack GitHub'), 'prompt forbids denying github');

    const devSkills = getEnabledSkillIds({ agentId: 'developer' });
    assert(devSkills.includes('github'), `developer gets github: ${devSkills.join(',')}`);

    const hint = buildGithubSourceIntentPlan(devSkills);
    assert(hint && hint.skills.includes('github'), 'github intent hint');

    console.log('| Test | Input | Output | Status |');
    console.log('| --- | --- | --- | --- |');
    console.log('| github-context | merge + hint | pass | ✅ Pass |');
    console.log('\ngithub-context tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
