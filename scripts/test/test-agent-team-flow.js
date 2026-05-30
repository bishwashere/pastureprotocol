#!/usr/bin/env node
/**
 * Agent team flow tests with explicit input/output (no daemon restart).
 * Covers: rename + alias resolution, add/remove team links, main → sub delegation.
 *
 * Usage: node scripts/test/test-agent-team-flow.js
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-team-flow-'));
mkdirSync(join(stateDir, 'workspace'), { recursive: true });
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
  'utf8',
);
process.env.COWCODE_STATE_DIR = stateDir;

const {
  ensureAgent,
  createAgent,
  saveAgentConfig,
  loadAgentConfig,
  getAgentTitle,
  getAgentMessagingPolicy,
  normalizeAgentTitle,
  normalizeAgentMessagingPolicy,
  syncAgentSendSkillInConfig,
  resolveAgentReference,
  appendAgentTitleAlias,
  agentSendEnabledForAgent,
} = await import('../../lib/agent-config.js');
const { executeAgentSend } = await import('../../lib/executors/agent-send.js');
const { shouldAckNewSessionOnly, NEW_SESSION_ACK } = await import('../../lib/chat-session.js');
const { formatHistoryForClassifier } = await import('../../lib/conversation-context.js');

/** Mirror dashboard PATCH /api/agents/:id/config (no restart). */
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
    config.agentMessaging = normalizeAgentMessagingPolicy({
      ...(config.agentMessaging || {}),
      ...patch.agentMessaging,
    });
  }
  syncAgentSendSkillInConfig(config);
  saveAgentConfig(agentId, config);
  return config;
}

const subAgentReplies = {
  marketer: 'Our tagline is: Ship faster, moo less.',
  alex: 'Alex here — I can help with backend API work.',
};

function mockRunner(opts) {
  const reply = subAgentReplies[opts.targetAgentId] || `[${opts.targetAgentId}] handled: ${opts.userText}`;
  return Promise.resolve({
    textToSend: reply,
    skillsCalled: [],
    agentId: opts.targetAgentId,
  });
}

const results = [];

function record(name, input, output, pass, detail = '') {
  results.push({ name, input, output, pass, detail });
  const icon = pass ? '✅' : '❌';
  console.log(`\n${icon} ${name}`);
  console.log('  INPUT:', typeof input === 'string' ? input : JSON.stringify(input, null, 2));
  console.log('  OUTPUT:', typeof output === 'string' ? output : JSON.stringify(output, null, 2));
  if (detail) console.log('  NOTE:', detail);
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

async function scenarioCreateTeamAndLinks() {
  ensureAgent('main');
  createAgent('marketer', { fromAgentId: 'main', title: 'Marketer' });
  createAgent('alex', { fromAgentId: 'main', title: 'Alex' });
  patchAgentConfig('main', {
    agentMessaging: { allow: ['marketer', 'alex'] },
  });
  const policy = getAgentMessagingPolicy('main');
  const pass = policy.allow.includes('marketer')
    && policy.allow.includes('alex')
    && agentSendEnabledForAgent('main');
  record(
    'Create team + link main → marketer, alex',
    'POST agents marketer, alex; PATCH main.agentMessaging.allow = [marketer, alex]',
    { allow: policy.allow, agentSendEnabled: agentSendEnabledForAgent('main') },
    pass,
  );
}

async function scenarioRenameWithoutRestart() {
  patchAgentConfig('marketer', { title: 'Chloe' });
  const byOldTitle = resolveAgentReference('Marketer');
  const byAlias = resolveAgentReference('chloe');
  const byNewTitle = resolveAgentReference('Chloe');
  const title = getAgentTitle('marketer');
  const pass = byOldTitle === 'marketer' && byAlias === 'marketer' && byNewTitle === 'marketer' && title === 'Chloe';
  record(
    'Rename marketer → Chloe (dashboard PATCH, no restart)',
    'PATCH marketer { title: "Chloe" } then resolveAgentReference("chloe")',
    {
      getAgentTitle: title,
      resolveMarketer: byOldTitle,
      resolveChloe: byAlias,
      resolveChloeTitle: byNewTitle,
    },
    pass,
  );
}

async function scenarioDelegateByRenamedName() {
  const userMessage = 'Ask Chloe what our tagline is';
  const toolResult = await executeAgentSend(
    {
      agentId: 'main',
      runInternalAgent: mockRunner,
      agentDepth: 0,
      agentCallChain: ['main'],
    },
    { agent: 'chloe', message: 'What is our tagline?' },
  );
  const parsed = parseJson(toolResult);
  const pass = !parsed.error
    && parsed.agent === 'marketer'
    && parsed.agentTitle === 'Chloe'
    && /Ship faster/.test(parsed.reply || '');
  record(
    'Main delegates using renamed alias "chloe"',
    { userMessage, toolCall: { agent: 'chloe', message: 'What is our tagline?' } },
    parsed,
    pass,
    pass ? `Surfaced to user would be: "Chloe replied: ${parsed.reply}"` : '',
  );
}

async function scenarioDelegateByCanonicalId() {
  const userMessage = 'Ask marketer for the tagline';
  const toolResult = await executeAgentSend(
    {
      agentId: 'main',
      runInternalAgent: mockRunner,
      agentDepth: 0,
      agentCallChain: ['main'],
    },
    { agent: 'marketer', message: 'What is our tagline?' },
  );
  const parsed = parseJson(toolResult);
  const pass = !parsed.error && parsed.agent === 'marketer' && /Ship faster/.test(parsed.reply || '');
  record(
    'Main delegates by canonical id "marketer"',
    { userMessage, toolCall: { agent: 'marketer', message: 'What is our tagline?' } },
    parsed,
    pass,
  );
}

async function scenarioRemoveLinkBlocksDelegation() {
  patchAgentConfig('main', { agentMessaging: { allow: ['marketer'] } });
  const toolResult = await executeAgentSend(
    {
      agentId: 'main',
      runInternalAgent: mockRunner,
      agentDepth: 0,
      agentCallChain: ['main'],
    },
    { agent: 'alex', message: 'ping' },
  );
  const parsed = parseJson(toolResult);
  const pass = !!parsed.error && /not linked/i.test(parsed.error);
  record(
    'Remove alex from team links → delegation blocked',
    'PATCH main.agentMessaging.allow = [marketer]; agent-send to alex',
    parsed,
    pass,
  );
}

async function scenarioReAddLinkWorks() {
  patchAgentConfig('main', { agentMessaging: { allow: ['marketer', 'alex'] } });
  const toolResult = await executeAgentSend(
    {
      agentId: 'main',
      runInternalAgent: mockRunner,
      agentDepth: 0,
      agentCallChain: ['main'],
    },
    { agent: 'alex', message: 'Are you there?' },
  );
  const parsed = parseJson(toolResult);
  const pass = !parsed.error && parsed.agent === 'alex' && /Alex here/.test(parsed.reply || '');
  record(
    'Re-add alex to team links → delegation works again',
    'PATCH main.agentMessaging.allow = [marketer, alex]; agent-send to alex',
    parsed,
    pass,
  );
}

async function scenarioStaleAllowListRepair() {
  const cfg = loadAgentConfig('main');
  cfg.agentMessaging = { allow: ['chloe', 'ghost', 'alex'] };
  saveAgentConfig('main', cfg);
  const repaired = getAgentMessagingPolicy('main');
  const pass = repaired.allow.includes('marketer')
    && repaired.allow.includes('alex')
    && !repaired.allow.includes('chloe')
    && !repaired.allow.includes('ghost');
  record(
    'Stale allow list "chloe" repairs to marketer id',
    'Save allow: [chloe, ghost, alex] then reload policy',
    { allow: repaired.allow },
    pass,
  );
}

async function scenarioShortReplyAfterRenameOffer() {
  const history = [
    { role: 'user', content: 'Can we rename marketer to a lady name?' },
    { role: 'assistant', content: 'Options: 1) Maya 2) Chloe. Which do you want?' },
    { role: 'user', content: 'Chloe' },
  ];
  const historySnippet = formatHistoryForClassifier(history, 2);
  const resolved = resolveAgentReference('Chloe');
  const pass = historySnippet.includes('Chloe') && resolved === 'marketer';
  record(
    'Short reply "Chloe" resolves to marketer after rename (history + alias)',
    { userMessage: 'Chloe', historySnippet: historySnippet.slice(0, 120) + '…' },
    { resolveAgentReference: resolved },
    pass,
  );
}

async function scenarioNewSessionAck() {
  const input = 'new session';
  const pass = shouldAckNewSessionOnly('manual', input);
  record(
    'New session command → brief ack (no LLM)',
    input,
    NEW_SESSION_ACK,
    pass && NEW_SESSION_ACK === 'New session started.',
  );
}

async function main() {
  console.log('Agent team flow tests (input/output)\n' + '='.repeat(60));

  await scenarioCreateTeamAndLinks();
  await scenarioRenameWithoutRestart();
  await scenarioDelegateByRenamedName();
  await scenarioDelegateByCanonicalId();
  await scenarioRemoveLinkBlocksDelegation();
  await scenarioReAddLinkWorks();
  await scenarioStaleAllowListRepair();
  await scenarioShortReplyAfterRenameOffer();
  await scenarioNewSessionAck();

  const failed = results.filter((r) => !r.pass).length;
  console.log('\n' + '='.repeat(60));
  console.log('\n| Test | Input (summary) | Output (summary) | Status |');
  console.log('| --- | --- | --- | --- |');
  for (const r of results) {
    const inSum = typeof r.input === 'string' ? r.input : JSON.stringify(r.input).slice(0, 80);
    const outSum = typeof r.output === 'string' ? r.output : JSON.stringify(r.output).slice(0, 100);
    console.log(`| ${r.name} | ${inSum.replace(/\|/g, '/')} | ${outSum.replace(/\|/g, '/')} | ${r.pass ? '✅ Pass' : '❌ Fail'} |`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
