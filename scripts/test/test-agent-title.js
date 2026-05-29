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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
