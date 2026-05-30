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

import { listAgentIds, getAgentMessagingPolicy, getAgentTitle, resolveAgentReference } from '../agent-config.js';

function err(message) {
  return JSON.stringify({ error: message });
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

  const callerAgentId = resolveAgentReference(ctx?.agentId) || 'main';
  const target = resolveAgentReference(args.agent ?? args.to ?? args.agentId);
  const message = String(args.message ?? args.text ?? '').trim();

  if (!target) {
    const hint = listAgentIds()
      .filter((id) => id !== callerAgentId && id !== 'reflector')
      .map((id) => {
        const title = getAgentTitle(id);
        return title ? `${id} (${title})` : id;
      })
      .join(', ');
    return err(`agent-send requires a valid "agent" id. Known agents: ${hint || 'none'}.`);
  }
  if (!message) return err('agent-send requires "message" (what to ask the target agent).');
  if (target === callerAgentId) return err(`Cannot message yourself ("${target}").`);

  const known = listAgentIds();
  if (!known.includes(target)) {
    return err(`Unknown agent "${target}". Available agents: ${known.join(', ') || 'none'}.`);
  }

  const chain = Array.isArray(ctx.agentCallChain) && ctx.agentCallChain.length
    ? ctx.agentCallChain
    : [callerAgentId];
  if (chain.includes(target)) {
    return err(`Loop blocked: "${target}" is already in this delegation chain (${chain.join(' -> ')}).`);
  }

  const policy = getAgentMessagingPolicy(callerAgentId);
  if (!policy.allow.includes(target)) {
    return err(
      `"${callerAgentId}" is not linked to "${target}". ` +
      `Add a team link from "${callerAgentId}" to "${target}" on the agent map.`
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

  try {
    const { textToSend, skillsCalled } = await runner({
      targetAgentId: target,
      userText: message,
      callerAgentId,
      depth: nextDepth,
      callChain: [...chain, target],
      persistHistory: true,
    });
    const reply = (textToSend || '').trim();
    if (!reply) return err(`Agent "${target}" returned an empty reply.`);
    return JSON.stringify({ agent: target, reply, skillsCalled: skillsCalled || [] });
  } catch (e) {
    return err(`Agent "${target}" failed: ${e?.message || String(e)}`);
  }
}
