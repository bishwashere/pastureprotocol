#!/usr/bin/env node
/**
 * Agent config contract tests — verifies disk config, aliases, allow-list repair.
 * Does NOT call the LLM or index.js --test. For real user chat + bot replies, run:
 *   pnpm run test:agent-team-e2e  (dashboard: "Agent Team E2E")
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSkillTests } from '../../support/skill-test-runner.js';

function createStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-agent-config-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
    'utf8',
  );
  process.env.PASTURE_STATE_DIR = stateDir;
  return stateDir;
}

async function loadAgentConfigModule() {
  return import('../../../../lib/agent/agent-config.js');
}

async function loadAgentSendModule() {
  return import('../../../../lib/agent/executors/agent-send.js');
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
      name: 'new agents default to full team links',
      input: 'Setup: create Marketer, then Alex — expect main, Marketer, and Alex all linked to each other',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
        const mainPolicy = ac.getAgentMessagingPolicy('main');
        const marketerPolicy = ac.getAgentMessagingPolicy('marketer');
        const alexPolicy = ac.getAgentMessagingPolicy('alex');
        const ok =
          mainPolicy.allow.includes('marketer') &&
          mainPolicy.allow.includes('alex') &&
          marketerPolicy.allow.includes('main') &&
          marketerPolicy.allow.includes('alex') &&
          alexPolicy.allow.includes('main') &&
          alexPolicy.allow.includes('marketer') &&
          ac.agentSendEnabledForAgent('main') &&
          ac.agentSendEnabledForAgent('marketer') &&
          ac.agentSendEnabledForAgent('alex');
        if (!ok) {
          throw new Error(
            `Expected full mesh links; main=[${mainPolicy.allow.join(', ')}], marketer=[${marketerPolicy.allow.join(', ')}], alex=[${alexPolicy.allow.join(', ')}]`,
          );
        }
        const output = `main=[${mainPolicy.allow.join(', ')}], marketer=[${marketerPolicy.allow.join(', ')}], alex=[${alexPolicy.allow.join(', ')}]`;
        return { reply: output };
      },
    },
    {
      name: 'agents in different teams are not eligible delegation peers',
      input: 'Setup: main+marketer default team, alex growth team — expect main cannot delegate to alex',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        const { executeAgentSend } = await loadAgentSendModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex', teamId: 'growth' });
        const mainPolicy = ac.getAgentMessagingPolicy('main');
        const alexPolicy = ac.getAgentMessagingPolicy('alex');
        if (!mainPolicy.allow.includes('marketer')) throw new Error(`Expected marketer in main allow: [${mainPolicy.allow.join(', ')}]`);
        if (mainPolicy.allow.includes('alex')) throw new Error(`Did not expect alex in main allow: [${mainPolicy.allow.join(', ')}]`);
        if (alexPolicy.allow.includes('main') || alexPolicy.allow.includes('marketer')) {
          throw new Error(`Did not expect cross-team peers in alex allow: [${alexPolicy.allow.join(', ')}]`);
        }
        const raw = await executeAgentSend({
          agentId: 'main',
          agentDepth: 0,
          agentCallChain: ['main'],
          runInternalAgent: async () => ({ textToSend: '[Pasture] should not run', skillsCalled: [] }),
        }, {
          agent: 'alex',
          message: 'Please help with this task.',
        });
        const out = JSON.parse(raw);
        if (!/cross-team|not linked/i.test(String(out.error || ''))) {
          throw new Error(`Expected cross-team/not-linked error, got ${raw}`);
        }
        return { reply: `main=[${mainPolicy.allow.join(', ')}], alex=[${alexPolicy.allow.join(', ')}], error=${out.error}` };
      },
    },
    {
      name: 'new agents inherit system LLM priority mode',
      input: 'Setup: main has openai priority; create alex — expect priorityMode=system and no copied priority flags',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        ac.ensureMainAgentInitialized();
        ac.saveAgentConfig('main', {
          llm: {
            models: [
              { provider: 'lmstudio', model: 'local', apiKey: 'not-needed', baseUrl: 'http://127.0.0.1:1234/v1' },
              { provider: 'openai', model: 'gpt-5.2', apiKey: 'LLM_1_API_KEY', priority: true },
            ],
          },
        });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
        const cfg = ac.loadAgentConfig('alex');
        const mode = cfg.llm && cfg.llm.priorityMode;
        const hasPriority = Array.isArray(cfg.llm?.models) && cfg.llm.models.some((m) => m && m.priority);
        if (mode !== 'system' || hasPriority) {
          throw new Error(`Expected system mode without copied priority; got mode=${mode}, hasPriority=${hasPriority}`);
        }
        return { reply: `priorityMode=${mode}, copiedPriority=${hasPriority}` };
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
    {
      name: 'auto delegation picks linked specialist by skills',
      input: 'Setup: main linked to marketer+alex; marketer has calendar, alex has github; agent-send auto with skill=github routes to alex',
      expectMode: 'behavior',
      run: async () => {
        createStateDir();
        const ac = await loadAgentConfigModule();
        const { executeAgentSend } = await loadAgentSendModule();
        ac.ensureMainAgentInitialized();
        ac.createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
        ac.createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
        await patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } }, ac);
        const marketerCfg = ac.loadAgentConfig('marketer');
        marketerCfg.skills = marketerCfg.skills || {};
        marketerCfg.skills.enabled = ['calendar'];
        ac.saveAgentConfig('marketer', marketerCfg);
        const alexCfg = ac.loadAgentConfig('alex');
        alexCfg.skills = alexCfg.skills || {};
        alexCfg.skills.enabled = ['github'];
        ac.saveAgentConfig('alex', alexCfg);
        let delegatedTo = '';
        const raw = await executeAgentSend({
          agentId: 'main',
          agentDepth: 0,
          agentCallChain: ['main'],
          runInternalAgent: async ({ targetAgentId }) => {
            delegatedTo = targetAgentId;
            return { textToSend: '[Pasture] stub reply', skillsCalled: [] };
          },
        }, {
          agent: 'auto',
          message: 'Please check this pull request and CI status.',
          skill: 'github',
        });
        const out = JSON.parse(raw);
        if (out.error) throw new Error(out.error);
        if (out.agent !== 'alex' || delegatedTo !== 'alex') {
          throw new Error(`Expected auto-route to alex, got out.agent=${out.agent}, delegatedTo=${delegatedTo}`);
        }
        const matched = Array.isArray(out.route?.matchedSkills) ? out.route.matchedSkills.join(',') : '';
        const output = `auto route=${out.route?.mode || 'none'}, agent=${out.agent}, matchedSkills=[${matched}]`;
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
