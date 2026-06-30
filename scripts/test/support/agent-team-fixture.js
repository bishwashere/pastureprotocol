/**
 * Test fixture setup for agent-team E2E (config on disk before first user message).
 * Not part of the runtime path — only prepares state.
 */

import { appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export const MARKETER_TAGLINE = 'Ship faster, moo less.';

/** Distinct specialist skills so delegation router can match by topic, not agent name. */
export async function configureSpecialistSkills() {
  const { loadAgentConfig, saveAgentConfig, syncAgentSendSkillInConfig } = await import('../../../lib/agent/agent-config.js');

  const marketerCfg = loadAgentConfig('marketer');
  marketerCfg.skills = marketerCfg.skills || {};
  marketerCfg.skills.enabled = ['calendar', 'gmail'];
  syncAgentSendSkillInConfig(marketerCfg);
  saveAgentConfig('marketer', marketerCfg);

  const alexCfg = loadAgentConfig('alex');
  alexCfg.skills = alexCfg.skills || {};
  alexCfg.skills.enabled = ['github', 'go-read'];
  syncAgentSendSkillInConfig(alexCfg);
  saveAgentConfig('alex', alexCfg);
}

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
  } = await import('../../../lib/agent/agent-config.js');
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
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.PASTURE_LLM_DELEGATION_ROUTER = '0';
  const { ensureMainAgentInitialized, createAgent, loadAgentConfig, saveAgentConfig, syncAgentSendSkillInConfig } =
    await import('../../../lib/agent/agent-config.js');
  const { getAgentWorkspaceDir } = await import('../../../lib/util/paths.js');

  ensureMainAgentInitialized();
  createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
  createAgent('alex', { fromAgentId: 'main', title: 'Alex' });

  writeFileSync(
    join(getAgentWorkspaceDir('marketer'), 'SOUL.md'),
    `You are the marketer agent. When asked about the company tagline, answer: "${MARKETER_TAGLINE}"`,
    'utf8',
  );
  writeFileSync(
    join(getAgentWorkspaceDir('alex'), 'SOUL.md'),
    'You are Alex the backend agent. For GitHub/CI/backend questions, give a brief helpful answer and sign off: "Alex here — ready to help with backend work."',
    'utf8',
  );

  await configureSpecialistSkills();

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

export async function seedAgentTeamStatusFixture(stateDir) {
  process.env.PASTURE_STATE_DIR = stateDir;
  const { getTeamActivityLogPath } = await import('../../../lib/util/paths.js');
  const base = Date.now() - 60_000;
  const rows = [];
  let i = 0;
  const push = (event) => {
    rows.push({
      id: `fixture-status-${i}`,
      ts: base + i++ * 1000,
      type: event.type || 'event',
      agentId: event.agentId || '',
      targetAgentId: event.targetAgentId || '',
      skillId: event.skillId || '',
      action: event.action || '',
      status: event.status || '',
      message: event.message || '',
      title: event.title || '',
      depth: Number.isFinite(event.depth) ? event.depth : null,
      jid: event.jid || 'fixture@local',
      details: event.details || null,
    });
  };
  const completedTurn = (agentId, title, doneMessage, skills = []) => {
    push({ type: 'turn_start', agentId, title, message: title });
    for (const skillId of skills) push({ type: 'skill_done', agentId, skillId, status: 'ok' });
    push({ type: 'turn_done', agentId, status: 'ok', title, message: doneMessage || `Completed ${title}.` });
  };

  completedTurn('alex', 'Reviewed GitHub CI failure in checkout tests', 'Completed CI failure review and proposed a dependency cache fix.', ['github', 'go-read']);
  completedTurn('alex', 'Audited database migration rollback path', 'Completed rollback audit with one follow-up note.', ['go-read']);
  completedTurn('alex', 'Checked API latency regression logs', 'Completed latency log review and found slow profile queries.', ['go-read']);
  completedTurn('alex', 'Drafted backend rollout checklist', 'Completed rollout checklist for the next deploy.', ['go-read']);
  completedTurn('alex', 'Validated webhook retry handling', 'Completed webhook retry validation.', ['github']);
  completedTurn('marketer', 'Drafted onboarding email experiment', 'Completed onboarding email experiment draft.', ['gmail']);
  completedTurn('marketer', 'Wrote pricing page tagline options', 'Completed pricing page tagline options.', ['calendar']);
  push({
    type: 'delegation_start',
    agentId: 'main',
    targetAgentId: 'alex',
    status: 'ok',
    title: 'Assign OAuth callback investigation',
    message: 'Assigned OAuth callback investigation to alex',
  });
  push({
    type: 'turn_start',
    agentId: 'alex',
    title: 'Investigate OAuth callback failures',
    message: 'Investigate OAuth callback failures after the auth deploy',
    details: { inbox: { kind: 'received_from', fromAgentId: 'main' } },
  });
  push({
    type: 'skill_error',
    agentId: 'alex',
    skillId: 'github',
    status: 'error',
    title: 'OAuth callback investigation blocked',
    message: 'Needs attention: missing GitHub token for OAuth callback investigation.',
  });

  appendFileSync(getTeamActivityLogPath(), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}
