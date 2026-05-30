/**
 * Test fixture setup for agent-team E2E (config on disk before first user message).
 * Not part of the runtime path — only prepares state.
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

export const MARKETER_TAGLINE = 'Ship faster, moo less.';

/** Mirror dashboard PATCH /api/agents/:id/config */
export async function patchAgentConfig(agentId, patch) {
  const {
    loadAgentConfig,
    saveAgentConfig,
    getAgentTitle,
    normalizeAgentTitle,
    appendAgentTitleAlias,
    normalizeAgentMessagingPolicy,
    syncAgentSendSkillInConfig,
  } = await import('../../lib/agent-config.js');
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
    config.agentMessaging = normalizeAgentMessagingPolicy({
      ...(config.agentMessaging || {}),
      ...patch.agentMessaging,
    });
  }
  syncAgentSendSkillInConfig(config);
  saveAgentConfig(agentId, config);
  return config;
}

/**
 * @param {string} stateDir
 * @param {{ allow?: string[], renameMarketerToChloe?: boolean }} [opts]
 */
export async function setupAgentTeamFixture(stateDir, opts = {}) {
  process.env.COWCODE_STATE_DIR = stateDir;
  const { ensureMainAgentInitialized, createAgent, loadAgentConfig, saveAgentConfig, syncAgentSendSkillInConfig } =
    await import('../../lib/agent-config.js');
  const { getAgentWorkspaceDir } = await import('../../lib/paths.js');

  ensureMainAgentInitialized();
  createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
  createAgent('alex', { fromAgentId: 'main', title: 'Alex' });

  writeFileSync(
    join(getAgentWorkspaceDir('marketer'), 'SOUL.md'),
    `You are the marketer agent. When asked about the company tagline, reply with exactly: "${MARKETER_TAGLINE}"`,
    'utf8',
  );
  writeFileSync(
    join(getAgentWorkspaceDir('alex'), 'SOUL.md'),
    'You are Alex the backend agent. When asked if you are there, reply: "Alex here — ready to help with backend work."',
    'utf8',
  );

  if (opts.renameMarketerToChloe) {
    await patchAgentConfig('marketer', { title: 'Chloe' });
  }

  const mainCfg = loadAgentConfig('main');
  mainCfg.agentMessaging = {
    allow: opts.allow || ['marketer', 'alex'],
    maxDepth: 2,
    maxCallsPerTurn: 5,
  };
  syncAgentSendSkillInConfig(mainCfg);
  saveAgentConfig('main', mainCfg);
}
