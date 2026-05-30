/**
 * Tests optional agent title + agentMessaging patch normalization.
 *
 * Usage: node scripts/test/test-agent-title.js
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-title-'));
mkdirSync(join(stateDir, 'workspace'), { recursive: true });
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
  'utf8'
);
process.env.COWCODE_STATE_DIR = stateDir;

const {
  ensureAgent,
  createAgent,
  saveAgentConfig,
  loadAgentConfig,
  getAgentTitle,
  normalizeAgentTitle,
  normalizeAgentMessagingPolicy,
  getAgentMessagingPolicy,
  syncAgentSendSkillInConfig,
  resolveEnabledSkillsForAgent,
  agentSendEnabledForAgent,
  resolveAgentReference,
  normalizeAgentAllowList,
  appendAgentTitleAlias,
  buildAgentTeamPromptBlock,
  listVisibleAgentIds,
  isInternalAgent,
  REFLECTOR_AGENT_ID,
} = await import('../../lib/agent-config.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  console.log('Test: agent title + messaging config.\n');

  ensureAgent('main');
  check('empty title when unset', getAgentTitle('main') === '');

  check('normalizeAgentTitle empty', normalizeAgentTitle('   ') === '');
  check('normalizeAgentTitle caps length', normalizeAgentTitle('x'.repeat(200)).length === 120);

  const created = createAgent('pm', { fromAgentId: 'main', title: 'Project Manager' });
  check('createAgent with title', created.created === true);
  check('createAgent title persisted', getAgentTitle('pm') === 'Project Manager');

  saveAgentConfig('pm', { ...loadAgentConfig('pm'), title: '  Primary  ' });
  check('getAgentTitle trims saved value', getAgentTitle('pm') === 'Primary');

  ensureAgent('backend');
  saveAgentConfig('pm', {
    ...loadAgentConfig('pm'),
    agentMessaging: { allow: ['backend'], maxDepth: 3, maxCallsPerTurn: 4 },
  });
  const policy = getAgentMessagingPolicy('pm');
  check('messaging allow preserved', policy.allow.includes('backend'));
  check('messaging maxDepth', policy.maxDepth === 3);
  check('messaging maxCallsPerTurn', policy.maxCallsPerTurn === 4);

  const normalized = normalizeAgentMessagingPolicy({ allow: [' Backend ', ''], maxDepth: 0, maxCallsPerTurn: -1 });
  check('normalize allow ids', normalized.allow.includes('backend') && normalized.allow.length === 1);
  check('normalize defaults for invalid nums', normalized.maxDepth === 2 && normalized.maxCallsPerTurn === 5);

  const withLinks = syncAgentSendSkillInConfig({
    skills: { enabled: ['search'] },
    agentMessaging: { allow: ['backend'] },
  });
  check('sync adds agent-send when links exist', withLinks.skills.enabled.includes('agent-send'));
  check('agentSendEnabledForAgent with links', agentSendEnabledForAgent('pm'));
  check('resolveEnabledSkillsForAgent injects agent-send', resolveEnabledSkillsForAgent('pm', ['search']).includes('agent-send'));

  const withoutLinks = syncAgentSendSkillInConfig({
    skills: { enabled: ['search', 'agent-send'] },
    agentMessaging: { allow: [] },
  });
  check('sync removes agent-send when no links', !withoutLinks.skills.enabled.includes('agent-send'));

  ensureAgent('marketer');
  ensureAgent('alex');
  saveAgentConfig('marketer', { ...loadAgentConfig('marketer'), title: 'Marketer' });
  check('resolveAgentReference by id', resolveAgentReference('marketer') === 'marketer');
  check('resolveAgentReference by title', resolveAgentReference('Marketer') === 'marketer');
  check('resolveAgentReference unknown', resolveAgentReference('chloe') === '');

  saveAgentConfig('main', {
    ...loadAgentConfig('main'),
    agentMessaging: { allow: ['alex', 'chloe', 'marketer'] },
  });
  const repaired = getAgentMessagingPolicy('main');
  check('allow list drops stale ids', !repaired.allow.includes('chloe'));
  check('allow list keeps valid ids', repaired.allow.includes('alex') && repaired.allow.includes('marketer'));

  saveAgentConfig('main', {
    ...loadAgentConfig('main'),
    title: 'CEO',
    agentMessaging: { allow: ['alex'] },
  });
  const reloaded = loadAgentConfig('main');
  check('main config survives reload (no legacy clobber)', reloaded.agentMessaging?.allow?.includes('alex'));

  const aliasCfg = loadAgentConfig('marketer');
  appendAgentTitleAlias(aliasCfg, 'Chloe');
  saveAgentConfig('marketer', aliasCfg);
  check('title alias resolves old name', resolveAgentReference('chloe') === 'marketer');

  const teamBlock = buildAgentTeamPromptBlock('main');
  check('team prompt lists canonical ids', teamBlock.includes('marketer') && teamBlock.includes('title: Marketer'));

  createAgent(REFLECTOR_AGENT_ID, { title: 'Reflector', fromAgentId: 'main', internal: true });
  check('reflector is internal', isInternalAgent(REFLECTOR_AGENT_ID));
  check('listVisibleAgentIds hides reflector', !listVisibleAgentIds().includes(REFLECTOR_AGENT_ID));
  check('team prompt hides reflector', !buildAgentTeamPromptBlock('main').toLowerCase().includes('reflector'));
  check('resolveAgentReference hides reflector by id', resolveAgentReference(REFLECTOR_AGENT_ID) === '');
  check('resolveAgentReference hides reflector by title', resolveAgentReference('Reflector') === '');
  check('allow list strips reflector', !normalizeAgentAllowList(['alex', REFLECTOR_AGENT_ID]).includes(REFLECTOR_AGENT_ID));

  let createRejected = false;
  try {
    createAgent(REFLECTOR_AGENT_ID, { fromAgentId: 'main' });
  } catch (_) {
    createRejected = true;
  }
  check('createAgent rejects reflector without internal flag', createRejected);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
