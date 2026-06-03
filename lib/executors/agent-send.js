/**
 * agent-send: let one agent delegate a message to another agent and get the reply.
 *
 * This is cowCode's tier-2 agent-to-agent ("PM to PM") path. It runs the target
 * agent through the silent internal runner (no channel send) and returns its
 * reply as the tool result so the calling agent can synthesize a final answer.
 *
 * The actual runner is injected on ctx (ctx.runInternalAgent) to avoid a circular
 * import between the skill executor and the runner. Guards (allowlist, depth,
 * loop, per-turn cap) are enforced here before any nested turn runs.
 */

import { listVisibleAgentIds, getAgentMessagingPolicy, getAgentTitle, resolveAgentReference, isInternalAgent, listAgentIds } from '../agent-config.js';
import { getEnabledSkillSummaries } from '../../skills/loader.js';
import { logTeamActivity } from '../team-activity.js';
import { buildDelegationStartInboxDetails } from '../team-inbox.js';
import {
  onAgentWaitingFor,
  onAgentDelegationDone,
  onAgentDelegationError,
} from '../agent-context-state.js';
import { enrichMessageWithProjectContext } from '../projects-context.js';
import {
  resolveGoalForDelegation,
  createDelegatedSubgoal,
  completeDelegatedSubgoal,
  failDelegatedSubgoal,
  newDelegationId,
} from '../delegated-tasks.js';

function err(message) {
  return JSON.stringify({ error: message });
}

function normalizeText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function normalizeSkillHints(args) {
  const out = [];
  const push = (value) => {
    const v = String(value || '').trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  if (typeof args?.skill === 'string') push(args.skill);
  if (typeof args?.skills === 'string') {
    args.skills
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach(push);
  }
  if (Array.isArray(args?.skills)) args.skills.forEach(push);
  return out;
}

function rankAutoTarget({ allow, message, skillHints }) {
  const messageNorm = normalizeText(message);
  const messageTokens = tokenize(messageNorm);
  const ranked = allow.map((agentId) => {
    const title = String(getAgentTitle(agentId) || '').trim();
    const titleNorm = normalizeText(title);
    const idNorm = normalizeText(agentId);
    const summaries = getEnabledSkillSummaries({ agentId });
    let score = 0;
    const matched = [];
    for (const hint of skillHints) {
      const hit = summaries.find((s) => normalizeText(s?.id || '') === hint);
      if (hit) {
        score += 12;
        if (!matched.includes(hit.id)) matched.push(hit.id);
      }
    }
    for (const s of summaries) {
      const skillId = normalizeText(s?.id || '');
      if (!skillId) continue;
      const skillWords = skillId.split(/[-_]/).filter((w) => w.length >= 3);
      if (messageNorm.includes(skillId)) {
        score += 7;
        if (!matched.includes(s.id)) matched.push(s.id);
      }
      const descNorm = normalizeText(s?.description || '');
      for (const tok of messageTokens) {
        if (skillWords.includes(tok)) {
          score += 3;
          if (!matched.includes(s.id)) matched.push(s.id);
        } else if (descNorm.includes(tok)) {
          score += 1;
          if (!matched.includes(s.id)) matched.push(s.id);
        }
      }
    }
    for (const tok of messageTokens) {
      if (idNorm.includes(tok)) score += 2;
      if (titleNorm && titleNorm.includes(tok)) score += 2;
    }
    return {
      agentId,
      score,
      matchedSkills: matched.slice(0, 8),
    };
  });
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matchedSkills.length !== a.matchedSkills.length) return b.matchedSkills.length - a.matchedSkills.length;
    return a.agentId.localeCompare(b.agentId);
  });
  return ranked[0] || null;
}

/**
 * @param {object} ctx - Injected: agentId (caller), runInternalAgent, agentDepth, agentCallChain.
 * @param {object} args - { agent: string, message: string }
 * @returns {Promise<string>} JSON string: { agent, reply } on success, { error } on failure.
 */
export async function executeAgentSend(ctx, args = {}) {
  const runner = ctx && typeof ctx.runInternalAgent === 'function' ? ctx.runInternalAgent : null;
  if (!runner) {
    return err('agent-send is not available in this context (no internal runner). It is disabled for cron and group runs.');
  }

  const rawCaller = String(ctx?.agentId || '').trim();
  const callerAgentId = (rawCaller && listAgentIds().includes(rawCaller))
    ? rawCaller
    : (resolveAgentReference(rawCaller) || 'main');
  const requestedTargetRaw = String(args.agent ?? args.to ?? args.agentId ?? '').trim();
  const wantsAuto = !requestedTargetRaw || /^(auto|best|smart|any)$/i.test(requestedTargetRaw);
  const target = wantsAuto ? '' : resolveAgentReference(requestedTargetRaw);
  const message = String(args.message ?? args.text ?? '').trim();
  const delegationHistory = Array.isArray(ctx?.delegationHistoryMessages) ? ctx.delegationHistoryMessages : [];
  const delegationMessage = enrichMessageWithProjectContext(message, delegationHistory);
  const skillHints = normalizeSkillHints(args);

  if (!target && !wantsAuto) {
    const hint = listVisibleAgentIds()
      .filter((id) => id !== callerAgentId)
      .map((id) => {
        const title = getAgentTitle(id);
        return title ? `${id} (${title})` : id;
      })
      .join(', ');
    return err(`agent-send requires a valid "agent" id. Known agents: ${hint || 'none'}.`);
  }
  if (!message) return err('agent-send requires "message" (what to ask the target agent).');
  const chain = Array.isArray(ctx.agentCallChain) && ctx.agentCallChain.length
    ? ctx.agentCallChain
    : [callerAgentId];

  const policy = getAgentMessagingPolicy(callerAgentId);
  let targetAgentId = target;
  let autoRoute = null;
  if (wantsAuto) {
    const autoAllow = policy.allow
      .filter((id) => id !== callerAgentId)
      .filter((id) => !chain.includes(id));
    if (!autoAllow.length) {
      return err(
        `"${callerAgentId}" has no eligible team links for auto delegation. ` +
        'Add outbound links on the agent map and try again.'
      );
    }
    autoRoute = rankAutoTarget({ allow: autoAllow, message, skillHints });
    targetAgentId = autoRoute?.agentId || '';
    if (!targetAgentId) {
      return err('Unable to auto-route this delegation. Specify "agent" explicitly.');
    }
  }
  if (isInternalAgent(targetAgentId)) return err(`Cannot delegate to internal agent "${targetAgentId}".`);
  if (targetAgentId === callerAgentId) return err(`Cannot message yourself ("${targetAgentId}").`);

  const known = listAgentIds();
  if (!known.includes(targetAgentId)) {
    return err(`Unknown agent "${targetAgentId}". Available agents: ${known.join(', ') || 'none'}.`);
  }
  if (chain.includes(targetAgentId)) {
    return err(`Loop blocked: "${targetAgentId}" is already in this delegation chain (${chain.join(' -> ')}).`);
  }

  if (!policy.allow.includes(targetAgentId)) {
    return err(
      `"${callerAgentId}" is not linked to "${targetAgentId}". ` +
      `Add a team link from "${callerAgentId}" to "${targetAgentId}" on the agent map.`
    );
  }

  const nextDepth = (Number.isFinite(ctx.agentDepth) ? ctx.agentDepth : 0) + 1;
  if (nextDepth > policy.maxDepth) {
    return err(`Delegation depth limit reached (maxDepth=${policy.maxDepth}).`);
  }

  // Per-turn fan-out cap, tracked on the stable ctx object for this turn.
  ctx._agentSendCount = (ctx._agentSendCount || 0) + 1;
  if (ctx._agentSendCount > policy.maxCallsPerTurn) {
    return err(`Per-turn delegation limit reached (maxCallsPerTurn=${policy.maxCallsPerTurn}).`);
  }

  const persistTask = args.persistTask !== false && args.persist !== false;
  const taskTitle = String(args.title ?? args.taskTitle ?? args.task_title ?? '').trim();
  const expectedOutput = String(args.expectedOutput ?? args.expected_output ?? '').trim();
  const dueInHoursRaw = Number(args.dueInHours ?? args.due_in_hours);
  const dueInHours = Number.isFinite(dueInHoursRaw) && dueInHoursRaw > 0 ? Math.floor(dueInHoursRaw) : 0;
  const explicitGoalId = String(args.goalId ?? args.goal_id ?? ctx?.goalId ?? '').trim();

  let delegatedTask = null;
  if (persistTask) {
    try {
      const goal = resolveGoalForDelegation({
        callerAgentId,
        goalId: explicitGoalId,
        message,
        ctx,
      });
      if (goal) {
        const delegationId = newDelegationId();
        const created = createDelegatedSubgoal({
          goalId: goal.id,
          assignee: targetAgentId,
          delegatedFrom: callerAgentId,
          delegationId,
          title: taskTitle,
          message,
          description: message,
          expectedOutput,
          dueInHours: dueInHours || 48,
        });
        if (created?.subgoal) {
          delegatedTask = {
            goalId: goal.id,
            goalTitle: goal.title || goal.objective || goal.id,
            subgoalId: created.subgoal.id,
            delegationId: created.delegationId,
            title: created.subgoal.title,
            expectedOutput: created.subgoal.expectedOutput || '',
            dueAt: created.subgoal.dueAt || 0,
            assignee: targetAgentId,
            delegatedFrom: callerAgentId,
          };
        }
      }
    } catch (persistErr) {
      console.log('[agent-send] delegated subgoal creation skipped:', persistErr?.message || persistErr);
    }
  }

  try {
    if (delegatedTask) {
      logTeamActivity({
        type: 'delegation_task_assigned',
        agentId: callerAgentId,
        targetAgentId,
        depth: nextDepth,
        jid: ctx?.jid || '',
        message: `Assigned "${delegatedTask.title}" to ${targetAgentId}`,
        details: {
          goalId: delegatedTask.goalId,
          subgoalId: delegatedTask.subgoalId,
          delegationId: delegatedTask.delegationId,
          expectedOutput: delegatedTask.expectedOutput,
          dueAt: delegatedTask.dueAt,
        },
      });
    }
    logTeamActivity({
      type: 'delegation_start',
      agentId: callerAgentId,
      targetAgentId: targetAgentId,
      depth: nextDepth,
      jid: ctx?.jid || '',
      message: autoRoute
        ? `Auto-routed by skills (${(autoRoute.matchedSkills || []).join(', ') || 'no direct skill match'})`
        : `Delegating to ${targetAgentId}`,
      details: buildDelegationStartInboxDetails({
        message,
        callerAgentId,
        targetAgentId,
        routing: ctx?.delegationRouting || null,
      }),
    });
    onAgentWaitingFor({
      agentId: callerAgentId,
      targetAgentId,
      task: message,
      targetGoal: delegatedTask?.goalTitle || (/blog|marketing|content|campaign|ad\b|newsletter|seo|social/i.test(message)
        ? 'Generate marketing ideas'
        : undefined),
      delegatedTask,
    });
    const { textToSend, skillsCalled } = await runner({
      targetAgentId,
      userText: delegationMessage,
      callerAgentId,
      depth: nextDepth,
      callChain: [...chain, targetAgentId],
      persistHistory: true,
      sharedHistoryMessages: delegationHistory.length ? delegationHistory : null,
      channelContext: ctx?.channelContext && typeof ctx.channelContext === 'object' ? ctx.channelContext : null,
    });
    const reply = (textToSend || '').trim();
    if (!reply) return err(`Agent "${targetAgentId}" returned an empty reply.`);
    const agentTitle = getAgentTitle(targetAgentId);
    logTeamActivity({
      type: 'delegation_done',
      agentId: callerAgentId,
      targetAgentId,
      status: 'ok',
      depth: nextDepth,
      jid: ctx?.jid || '',
      message: autoRoute
        ? `${agentTitle || targetAgentId} replied (auto-route)`
        : `${agentTitle || targetAgentId} replied`,
    });
    onAgentDelegationDone({
      callerAgentId,
      targetAgentId,
      delegatedTask,
      replySummary: reply.slice(0, 200),
    });
    if (delegatedTask) {
      completeDelegatedSubgoal(delegatedTask, { replySummary: reply.slice(0, 200) });
    }
    return JSON.stringify({
      agent: targetAgentId,
      agentTitle: agentTitle || targetAgentId,
      reply,
      skillsCalled: skillsCalled || [],
      delegatedTask: delegatedTask || undefined,
      route: autoRoute
        ? {
            mode: 'auto',
            score: autoRoute.score,
            matchedSkills: autoRoute.matchedSkills || [],
          }
        : { mode: 'explicit' },
      summary: `${agentTitle || targetAgentId} replied: ${reply}`,
    });
  } catch (e) {
    logTeamActivity({
      type: 'delegation_error',
      agentId: callerAgentId,
      targetAgentId,
      status: 'error',
      depth: nextDepth,
      jid: ctx?.jid || '',
      message: e?.message || String(e),
    });
    onAgentDelegationError({
      callerAgentId,
      targetAgentId,
      message: e?.message || String(e),
      delegatedTask,
    });
    if (delegatedTask) {
      failDelegatedSubgoal(delegatedTask, e?.message || String(e));
    }
    return err(`Agent "${targetAgentId}" failed: ${e?.message || String(e)}`);
  }
}
