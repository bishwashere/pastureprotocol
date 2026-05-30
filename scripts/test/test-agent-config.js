#!/usr/bin/env node
/**
 * Agent config contract tests — verifies disk config, aliases, allow-list repair.
 * Does NOT call the LLM or index.js --test. For real user chat + bot replies, run:
 *   pnpm run test:agent-team-e2e  (dashboard: "Agent Team E2E")
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSkillTests } from './skill-test-runner.js';

function createStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-config-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
    'utf8',
  );
  process.env.COWCODE_STATE_DIR = stateDir;
  return stateDir;
}

async function loadAgentConfigModule() {
  return import('../../lib/agent-config.js');
}

async function patchAgentConfig(agentId, patch, ac) {
  const {
    loadAgentConfig,
    saveAgentConfig,
    getAgentTitle,
    normalizeAgentTitle,
    appendAgentTitleAlias,
    syncAgentSendSkillInConfig,
  } = ac;
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

async function main() {
  console.log('Agent config unit tests (no LLM — use Agent Team E2E for chat scenarios)\n');

  const tests = [
    {
      name: 'team links enable agent-send on main',
      input: 'Setup: main.agentMessaging.allow = [marketer, alex]',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } }, ac);
        const policy = ac.getAgentMessagingPolicy('main');
        const ok =
          policy.allow.includes('marketer') &&
          policy.allow.includes('alex') &&
          ac.agentSendEnabledForAgent('main');
        if (!ok) throw new Error(`Expected marketer+alex linked; got allow=${policy.allow.join(',')}`);
        const output = `allow=[${policy.allow.join(', ')}], agent-send enabled=${ac.agentSendEnabledForAgent('main')}`;
        return { reply: output };
      },
    },
    {
      name: 'rename marketer → Chloe keeps id + aliases',
      input: 'Setup: PATCH marketer title to Chloe, then resolve Marketer / chloe / Chloe',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
        await patchAgentConfig('marketer', { title: 'Chloe' }, ac);
        const byOldTitle = ac.resolveAgentReference('Marketer');
        const byAlias = ac.resolveAgentReference('chloe');
        const byNewTitle = ac.resolveAgentReference('Chloe');
        const title = ac.getAgentTitle('marketer');
        const ok =
          byOldTitle === 'marketer' &&
          byAlias === 'marketer' &&
          byNewTitle === 'marketer' &&
          title === 'Chloe';
        if (!ok) {
          throw new Error(
            `resolve failed: Marketer→${byOldTitle}, chloe→${byAlias}, Chloe→${byNewTitle}, title=${title}`,
          );
        }
        const output = `canonical id=marketer, display title=${title}, Marketer→${byOldTitle}, chloe→${byAlias}, Chloe→${byNewTitle}`;
        return { reply: output };
      },
    },
    {
      name: 'stale allow list repairs nickname to canonical id',
      input: 'Setup: save allow [chloe, ghost, alex] — expect marketer (not chloe), no ghost',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Chloe' });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
        const cfg = ac.loadAgentConfig('main');
        cfg.agentMessaging = { allow: ['chloe', 'ghost', 'alex'] };
        ac.saveAgentConfig('main', cfg);
        const repaired = ac.getAgentMessagingPolicy('main');
        const ok =
          repaired.allow.includes('marketer') &&
          repaired.allow.includes('alex') &&
          !repaired.allow.includes('ghost') &&
          !repaired.allow.includes('chloe');
        if (!ok) throw new Error(`allow repair failed: [${repaired.allow.join(', ')}]`);
        const output = `repaired allow=[${repaired.allow.join(', ')}] (chloe→marketer, ghost dropped)`;
        return { reply: output };
      },
    },
  ];

  const { failed } = await runSkillTests('agent-config', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
