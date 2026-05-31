#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-metrics-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { logTeamActivity } = await import('../../lib/team-activity.js');
    const { computeAgentMetrics, readAgentMetrics } = await import('../../lib/agent-metrics.js');

    const t0 = Date.now();
    logTeamActivity({
      type: 'turn_start',
      agentId: 'main',
      jid: 'user@local',
      message: 'blog ideas for nextpostai.com',
      details: { inbox: { kind: 'received', task: 'blog ideas' } },
    });
    logTeamActivity({ type: 'skill_done', agentId: 'main', skillId: 'search', status: 'ok' });
    logTeamActivity({ type: 'skill_done', agentId: 'main', skillId: 'memory', status: 'ok' });
    logTeamActivity({ type: 'skill_done', agentId: 'main', skillId: 'search', status: 'ok' });
    logTeamActivity({
      type: 'delegation_start',
      agentId: 'main',
      targetAgentId: 'marketer',
      details: { inbox: { kind: 'delegated_to', toAgentId: 'marketer' } },
    });
    logTeamActivity({
      type: 'turn_start',
      agentId: 'marketer',
      jid: 'internal:main->marketer',
      message: 'blog ideas for nextpostai.com',
      details: { inbox: { kind: 'received_from', fromAgentId: 'main' } },
    });
    logTeamActivity({ type: 'skill_done', agentId: 'marketer', skillId: 'search', status: 'ok' });
    logTeamActivity({ type: 'skill_done', agentId: 'marketer', skillId: 'browse', status: 'ok' });
    logTeamActivity({
      type: 'turn_done',
      agentId: 'marketer',
      status: 'ok',
      message: `Handled in ${2400}ms using 2 skills.`,
    });
    logTeamActivity({ type: 'delegation_done', agentId: 'main', targetAgentId: 'marketer', status: 'ok' });
    logTeamActivity({
      type: 'turn_done',
      agentId: 'main',
      status: 'ok',
      message: `Handled in ${3600}ms using 3 skills.`,
    });

    const events = [
      { type: 'turn_start', agentId: 'main', ts: t0, jid: 'user@local', details: { inbox: { kind: 'received' } } },
      { type: 'skill_done', agentId: 'main', skillId: 'search', ts: t0 + 1 },
      { type: 'skill_done', agentId: 'main', skillId: 'memory', ts: t0 + 2 },
      { type: 'skill_done', agentId: 'main', skillId: 'search', ts: t0 + 3 },
      { type: 'delegation_start', agentId: 'main', targetAgentId: 'marketer', ts: t0 + 4 },
      {
        type: 'turn_start',
        agentId: 'marketer',
        ts: t0 + 5,
        jid: 'internal:main->marketer',
        details: { inbox: { kind: 'received_from', fromAgentId: 'main' } },
      },
      { type: 'skill_done', agentId: 'marketer', skillId: 'search', ts: t0 + 6 },
      { type: 'skill_done', agentId: 'marketer', skillId: 'browse', ts: t0 + 7 },
      { type: 'turn_done', agentId: 'marketer', ts: t0 + 8, message: 'Handled in 2400ms using 2 skills.' },
      { type: 'turn_done', agentId: 'main', ts: t0 + 9, message: 'Handled in 3600ms using 3 skills.' },
    ];

    const mainMetrics = computeAgentMetrics('main', events);
    assert(mainMetrics.tasksHandled === 1, `main tasks: ${mainMetrics.tasksHandled}`);
    assert(mainMetrics.delegatedOut === 1, `main delegated: ${mainMetrics.delegatedOut}`);
    assert(mainMetrics.receivedFromOthers === 0, `main received: ${mainMetrics.receivedFromOthers}`);
    assert(mainMetrics.averageExecutionSec === '3.6s', `main avg: ${mainMetrics.averageExecutionSec}`);
    assert(mainMetrics.mostUsedSkills[0].skillId === 'search', 'main top skill search');
    assert(mainMetrics.mostUsedSkills.some((s) => s.skillId === 'memory'), 'main uses memory');

    const marketerMetrics = computeAgentMetrics('marketer', events);
    assert(marketerMetrics.tasksHandled === 1, `marketer tasks: ${marketerMetrics.tasksHandled}`);
    assert(marketerMetrics.receivedFromOthers === 1, `marketer received: ${marketerMetrics.receivedFromOthers}`);
    assert(marketerMetrics.averageExecutionSec === '2.4s', `marketer avg: ${marketerMetrics.averageExecutionSec}`);
    const marketerSkillIds = marketerMetrics.mostUsedSkills.map((s) => s.skillId).sort();
    assert(marketerSkillIds.join(',') === 'browse,search', `marketer skills: ${marketerSkillIds.join(',')}`);
    assert(mainMetrics.lastActivity === 'done', `main last: ${mainMetrics.lastActivity}`);
    assert(marketerMetrics.lastActivity === 'done', `marketer last: ${marketerMetrics.lastActivity}`);
    assert(mainMetrics.tasksToday >= 0, 'tasksToday present');

    const memEvents = [
      { type: 'skill_done', agentId: 'developer', skillId: 'memory', ts: Date.now() },
    ];
    const devMetrics = computeAgentMetrics('developer', memEvents);
    assert(devMetrics.lastActivity === 'mem', `dev last: ${devMetrics.lastActivity}`);

    const delegEvents = [
      { type: 'delegation_start', agentId: 'main', targetAgentId: 'marketer', ts: Date.now() },
    ];
    assert(computeAgentMetrics('main', delegEvents).lastActivity === 'deleg', 'deleg last activity');

    const snapshot = readAgentMetrics({ agentId: 'main' });
    assert(snapshot.agent.tasksHandled >= 1, 'readAgentMetrics returns main stats');
    assert(snapshot.agents.main, 'snapshot includes all agents');

    console.log('agent-metrics tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
