#!/usr/bin/env node
/**
 * Core isolation contract for API-only agents.
 *
 * This test does not exercise UI controls. It verifies the backend boundaries
 * that make an isolated agent isolated:
 * - Hidden from visible team/delegation pool.
 * - No agent-send/evaluate-team-capability tools, even when copied from a
 *   linked main agent.
 * - No team roster prompt leakage.
 * - Own system prompt, bootstrap context, chat session key, chat log path.
 * - Memory config points at the isolated agent workspace/index.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSkillTests } from '../../support/skill-test-runner.js';

const MAIN_SECRET = 'MAIN_ONLY_SECRET_9911';
const API_SECRET = 'API_ONLY_SECRET_2244';

function setupState() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-isolated-core-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  delete process.env.OPENAI_API_KEY;
  delete process.env.LLM_1_API_KEY;

  const legacyWorkspace = join(stateDir, 'workspace');
  mkdirSync(legacyWorkspace, { recursive: true });
  writeFileSync(join(legacyWorkspace, 'SOUL.md'), `# Main\n${MAIN_SECRET}`, 'utf8');
  writeFileSync(join(legacyWorkspace, 'WhoAmI.md'), `# Main identity\n${MAIN_SECRET}`, 'utf8');
  writeFileSync(join(legacyWorkspace, 'MyHuman.md'), `# Main human\n${MAIN_SECRET}`, 'utf8');
  writeFileSync(join(legacyWorkspace, 'MEMORY.md'), `Main memory ${MAIN_SECRET}`, 'utf8');
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({
      agents: { defaults: { userTimezone: 'UTC', sessionResetHour: 3 } },
      llm: { models: [] },
      skills: { enabled: ['search', 'memory', 'read', 'agent-send', 'evaluate-team-capability'] },
      memory: { embedding: { provider: 'ollama' } },
    }, null, 2),
    'utf8',
  );
  return stateDir;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listJsonlRows(dir) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line.trim());
    for (const line of lines) rows.push(JSON.parse(line));
  }
  return rows;
}

async function buildFixture() {
  const stateDir = setupState();
  const ac = await import('../../../../lib/agent/agent-config.js');
  const paths = await import('../../../../lib/util/paths.js');
  const chatLog = await import('../../../../lib/context/chat-log.js');

  ac.ensureMainAgentInitialized();
  ac.createAgent('normal-peer', { fromAgentId: 'main', title: 'Normal Peer' });

  // At this point main is linked to normal-peer, so copying from main is the
  // risky path: an isolated agent must not inherit agent-send/evaluation tools.
  ac.createAgent('api-isolated', {
    fromAgentId: 'main',
    title: 'API Isolated',
    surface: 'api',
    visibility: 'api_only',
    visibleInTeam: false,
    autoLinkTeam: false,
    memoryScope: 'agent',
    sessionScope: 'agent',
  });

  const mainWorkspace = paths.getAgentWorkspaceDir('main');
  const apiWorkspace = paths.getAgentWorkspaceDir('api-isolated');
  writeFileSync(join(apiWorkspace, 'SOUL.md'), `# API\n${API_SECRET}`, 'utf8');
  writeFileSync(join(apiWorkspace, 'WhoAmI.md'), `# API identity\n${API_SECRET}`, 'utf8');
  writeFileSync(join(apiWorkspace, 'MyHuman.md'), `# API human\n${API_SECRET}`, 'utf8');
  writeFileSync(join(apiWorkspace, 'MEMORY.md'), `API memory ${API_SECRET}`, 'utf8');

  chatLog.appendExchange(mainWorkspace, {
    jid: 'owner',
    sessionId: 'main-session',
    user: `main user ${MAIN_SECRET}`,
    assistant: `main assistant ${MAIN_SECRET}`,
    timestampMs: Date.now(),
  });
  chatLog.appendExchange(apiWorkspace, {
    jid: 'api:api-isolated:prior',
    sessionId: 'api-session',
    user: `api user ${API_SECRET}`,
    assistant: `api assistant ${API_SECRET}`,
    timestampMs: Date.now(),
  });

  return { stateDir, ac, paths, mainWorkspace, apiWorkspace };
}

async function main() {
  console.log('Isolated agent core isolation tests (no live LLM)\n');

  const tests = [
    {
      name: 'API-only agent hidden from visible team pool',
      input: 'Create normal-peer and api-isolated; list visible agents',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, ac } = await buildFixture();
        try {
          const visible = ac.listVisibleAgentIds();
          if (visible.includes('api-isolated')) throw new Error(`visible list leaked api-isolated: ${visible.join(',')}`);
          if (!visible.includes('normal-peer')) throw new Error(`normal-peer missing from visible list: ${visible.join(',')}`);
          if (ac.isAgentVisibleInTeam('api-isolated') !== false) throw new Error('api-isolated should not be visible in team');
          return { reply: `visible=[${visible.join(', ')}]` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only agent has zero delegation policy',
      input: 'Read getAgentMessagingPolicy(api-isolated)',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, ac } = await buildFixture();
        try {
          const policy = ac.getAgentMessagingPolicy('api-isolated');
          if (policy.allow.length !== 0 || policy.maxDepth !== 0 || policy.maxCallsPerTurn !== 0) {
            throw new Error(`bad policy: ${JSON.stringify(policy)}`);
          }
          const mainPolicy = ac.getAgentMessagingPolicy('main');
          if (mainPolicy.allow.includes('api-isolated')) throw new Error(`main links to api-isolated: ${mainPolicy.allow.join(',')}`);
          return { reply: `policy=${JSON.stringify(policy)}, mainAllow=[${mainPolicy.allow.join(', ')}]` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only agent cannot receive agent-send tools even when copied from linked main',
      input: 'Check enabled skills and tool schemas for api-isolated',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir } = await buildFixture();
        try {
          const loader = await import('../../../../skills/loader.js');
          const ids = loader.getEnabledSkillIds({ agentId: 'api-isolated' });
          if (ids.includes('agent-send')) throw new Error(`agent-send present in enabled ids: ${ids.join(',')}`);
          if (ids.includes('evaluate-team-capability')) throw new Error(`evaluate-team-capability present in enabled ids: ${ids.join(',')}`);
          const skillContext = loader.getSkillContext({ agentId: 'api-isolated' });
          const toolJson = JSON.stringify(skillContext.runSkillTool || []);
          if (toolJson.includes('agent-send') || toolJson.includes('evaluate-team-capability')) {
            throw new Error(`delegation tool leaked into schema: ${toolJson.slice(0, 300)}`);
          }
          const cfg = readJson(join(stateDir, 'agents', 'api-isolated', 'config.json'));
          if (Array.isArray(cfg.skills?.enabled) && cfg.skills.enabled.includes('agent-send')) {
            throw new Error(`agent-send persisted in config: ${cfg.skills.enabled.join(',')}`);
          }
          return { reply: `enabled=[${ids.join(', ')}]` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only agent receives no team roster prompt',
      input: 'Build team prompt for api-isolated',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, ac } = await buildFixture();
        try {
          const apiBlock = ac.buildAgentTeamPromptBlock('api-isolated');
          if (apiBlock.trim()) throw new Error(`expected empty team block, got: ${apiBlock}`);
          const mainBlock = ac.buildAgentTeamPromptBlock('main');
          if (mainBlock.includes('api-isolated')) throw new Error(`main team block leaked api-isolated: ${mainBlock}`);
          if (!mainBlock.includes('normal-peer')) throw new Error('main team block should include visible normal-peer');
          return { reply: 'api team block empty; main block excludes api-isolated' };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only system prompt reads own workspace, not main workspace',
      input: 'Build one-on-one prompt from api-isolated workspace',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, apiWorkspace } = await buildFixture();
        try {
          const { buildOneOnOneSystemPrompt } = await import('../../../../lib/agent/system-prompt.js');
          const prompt = buildOneOnOneSystemPrompt(apiWorkspace);
          if (!prompt.includes(API_SECRET)) throw new Error('api prompt missing API workspace marker');
          if (prompt.includes(MAIN_SECRET)) throw new Error('api prompt leaked main workspace marker');
          return { reply: 'system prompt contains API marker only' };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only bootstrap reads own memory/logs, not main history',
      input: 'Build session bootstrap from api-isolated workspace and api log key',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, apiWorkspace } = await buildFixture();
        try {
          const { buildSessionBootstrapContext } = await import('../../../../lib/agent/session-bootstrap.js');
          const bootstrap = buildSessionBootstrapContext(apiWorkspace, {
            logJid: 'api:api-isolated:prior',
            tz: 'UTC',
            now: new Date(),
          });
          if (!bootstrap.block.includes(API_SECRET)) throw new Error('bootstrap missing API marker');
          if (bootstrap.block.includes(MAIN_SECRET)) throw new Error('bootstrap leaked main marker');
          return { reply: `sources=[${bootstrap.sources.join(', ')}]` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API-only memory config points to own workspace index',
      input: 'Resolve getMemoryConfig(apiConfig, { workspaceDir: apiWorkspace })',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, apiWorkspace, ac } = await buildFixture();
        try {
          const { getMemoryConfig } = await import('../../../../lib/context/memory-config.js');
          const cfg = getMemoryConfig(ac.loadAgentConfig('api-isolated'), { workspaceDir: apiWorkspace });
          if (!cfg) throw new Error('memory config was null');
          const expectedIndex = join(apiWorkspace, '.memory', 'index.db');
          if (cfg.workspaceDir !== apiWorkspace) throw new Error(`workspace mismatch: ${cfg.workspaceDir}`);
          if (cfg.indexPath !== expectedIndex) throw new Error(`index mismatch: ${cfg.indexPath}`);
          return { reply: `index=${cfg.indexPath}` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
    {
      name: 'API chat writes api:<agent>:<conversation> session/log under own workspace',
      input: 'runAgentApiChatTurn(api-isolated, "new session", conversationId=core)',
      expectMode: 'behavior',
      run: async () => {
        const { stateDir, apiWorkspace, mainWorkspace } = await buildFixture();
        try {
          const { runAgentApiChatTurn } = await import('../../../../lib/agent/api-chat-turn.js');
          const turn = await runAgentApiChatTurn({
            agentId: 'api-isolated',
            userText: 'new session',
            conversationId: 'core',
          });
          if (turn.reply !== 'New session started.') throw new Error(`unexpected reply: ${turn.reply}`);
          if (turn.logKey !== 'api:api-isolated:core') throw new Error(`bad logKey: ${turn.logKey}`);
          const sessions = readJson(join(stateDir, 'chat-sessions', 'state.json'));
          if (!sessions['api:api-isolated:core']) throw new Error('session key missing');
          const apiRows = listJsonlRows(join(apiWorkspace, 'chat-log', 'private'));
          const mainRows = listJsonlRows(join(mainWorkspace, 'chat-log', 'private'));
          if (!apiRows.some((row) => row.jid === 'api:api-isolated:core' && row.user === 'new session')) {
            throw new Error('api workspace log missing new session exchange');
          }
          if (mainRows.some((row) => row.jid === 'api:api-isolated:core')) {
            throw new Error('api exchange leaked into main workspace log');
          }
          return { reply: `logKey=${turn.logKey}, sessionId=${turn.sessionId}` };
        } finally {
          rmSync(stateDir, { recursive: true, force: true });
        }
      },
    },
  ];

  const { failed } = await runSkillTests('isolated-agent-core', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
