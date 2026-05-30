#!/usr/bin/env node
/**
 * Agent config contract tests (no LLM, no executeAgentSend mocks).
 * Replaces scenarios that lived in deleted test-agent-team-flow.js — see agent-team/inputs.md.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-config-'));
mkdirSync(join(stateDir, 'workspace'), { recursive: true });
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
  'utf8',
);
process.env.COWCODE_STATE_DIR = stateDir;

const {
  ensureMainAgentInitialized,
  createAgent,
  saveAgentConfig,
  loadAgentConfig,
  getAgentTitle,
  getAgentMessagingPolicy,
  resolveAgentReference,
  appendAgentTitleAlias,
  normalizeAgentTitle,
  syncAgentSendSkillInConfig,
  agentSendEnabledForAgent,
} = await import('../../lib/agent-config.js');

function patchAgentConfig(agentId, patch) {
  const config = loadAgentConfig(agentId);
  if (patch.title !== undefined) {
    const previousTitle = getAgentTitle(agentId);
    const t = normalizeAgentTitle(patch.title);
    if (t) {
      config.title = t;
      if (previousTitle && previousTitle.toLowerCase() !== t.toLowerCase()) {
        appendAgentTitleAlias(config, previousTitle);
      }
    } else {
      delete config.title;
    }
  }
  if (patch.agentMessaging !== undefined) {
    config.agentMessaging = { ...(config.agentMessaging || {}), ...patch.agentMessaging };
  }
  syncAgentSendSkillInConfig(config);
  saveAgentConfig(agentId, config);
  return config;
}

function check(name, ok, detail = '') {
  const icon = ok ? '✅' : '❌';
  console.log(`${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

let failed = 0;

ensureMainAgentInitialized();
createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } });

const policy = getAgentMessagingPolicy('main');
check(
  'team links enable agent-send on main',
  policy.allow.includes('marketer') && policy.allow.includes('alex') && agentSendEnabledForAgent('main'),
  `allow=${policy.allow.join(',')}`,
);

patchAgentConfig('marketer', { title: 'Chloe' });
const byOldTitle = resolveAgentReference('Marketer');
const byAlias = resolveAgentReference('chloe');
const byNewTitle = resolveAgentReference('Chloe');
check(
  'rename marketer → Chloe keeps id + aliases',
  byOldTitle === 'marketer' && byAlias === 'marketer' && byNewTitle === 'marketer' && getAgentTitle('marketer') === 'Chloe',
);

const cfg = loadAgentConfig('main');
cfg.agentMessaging = { allow: ['chloe', 'ghost', 'alex'] };
saveAgentConfig('main', cfg);
const repaired = getAgentMessagingPolicy('main');
check(
  'stale allow "chloe" repairs to marketer; drops ghost',
  repaired.allow.includes('marketer') && repaired.allow.includes('alex') && !repaired.allow.includes('ghost'),
  `allow=${repaired.allow.join(',')}`,
);

console.log(failed ? `\n${failed} failed` : '\nAll agent-config checks passed.');
process.exit(failed > 0 ? 1 : 0);
