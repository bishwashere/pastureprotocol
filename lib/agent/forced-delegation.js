/**
 * Shared "forced agent-send" runner used by index.js, internal-agent-turn.js,
 * and scripts/chat-dashboard.js when the pre-turn router decides to delegate
 * before letting the LLM see the request.
 *
 * Audit finding #9: previously each caller had its own copy of "execute
 * agent-send, parse the JSON, build a turn result." `internal-agent-turn.js`
 * silently swallowed errors (`catch (_) {}`) and skipped lifecycle hooks;
 * `index.js` logged team_activity and propagated routing details. This made
 * the same routing decision behave differently per channel.
 *
 * This helper centralizes the actual `executeSkill('agent-send', ...)` call
 * + structured-result parsing. Lifecycle hooks (onAgentTurnStart/Done) and
 * channel-specific bookkeeping stay with each caller because they legitimately
 * vary, but the inner contract is now identical.
 */

import { executeSkill } from '../../skills/executor.js';
import { parseSkillResult } from '../../skills/executor.js';

/**
 * @param {object} ctx - Agent ctx (jid, agentId, sock, etc.)
 * @param {object} opts
 * @param {string} opts.target - target agentId
 * @param {string} opts.message - message to send
 * @param {object} [opts.extraArgs] - extra agent-send args (e.g. `mission`, `delegationId`)
 * @returns {Promise<{
 *   ok: boolean,
 *   textToSend?: string,
 *   skillsCalled: string[],
 *   reply?: string,
 *   agentTitle?: string,
 *   error?: string,
 *   delegatedTask?: object,
 *   delegatedTaskStatus?: string,
 * }>}
 */
export async function executeForcedDelegation(ctx, opts = {}) {
  const target = String(opts.target || '').trim();
  const message = String(opts.message || '').trim();
  if (!target || !message) {
    return {
      ok: false,
      skillsCalled: [],
      error: 'forced delegation requires target and message',
    };
  }
  const args = {
    agent: target,
    message,
    ...(opts.extraArgs && typeof opts.extraArgs === 'object' ? opts.extraArgs : {}),
  };
  let raw;
  try {
    raw = await executeSkill('agent-send', ctx, args);
  } catch (err) {
    const errMsg = err?.message || String(err);
    console.log('[forced-delegation] agent-send threw:', errMsg);
    return { ok: false, skillsCalled: [], error: errMsg };
  }
  const skillRes = parseSkillResult(raw);
  if (!skillRes.ok) {
    console.log('[forced-delegation] agent-send returned error:', skillRes.error);
    return {
      ok: false,
      skillsCalled: ['agent-send'],
      error: skillRes.error || 'agent-send failed',
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    parsed = null;
  }
  const reply = parsed && typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (!reply) {
    return {
      ok: false,
      skillsCalled: ['agent-send'],
      error: parsed?.error || 'agent-send returned no reply',
    };
  }
  return {
    ok: true,
    skillsCalled: ['agent-send'],
    textToSend: reply,
    reply,
    agentTitle: parsed?.agentTitle || target,
    delegatedTask: parsed?.delegatedTask,
    delegatedTaskStatus: parsed?.delegatedTaskStatus,
  };
}
