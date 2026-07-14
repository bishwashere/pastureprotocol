/**
 * Shared agent turn: tool loop (run_skill) + final reply resolution.
 * Used by both chat (index.js) and cron runner so the LLM can call the same skills in both.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chat as llmChat, chatWithTools } from '../../llm.js';
import { executeSkill, parseSkillResult } from '../../skills/executor.js';
import { toUserMessage } from '../util/user-error.js';
import { logTeamActivity } from './team-activity.js';
import { logTiming } from '../util/request-timing.js';
import { buildTurnStartInboxDetails, buildTurnDoneInboxDetails } from './team-inbox.js';
import { syncTurnToProjectWork } from '../context/project-workflow.js';
import {
  onAgentTurnStart,
  onAgentSkillStart,
  onAgentSkillError,
  onAgentTurnDone,
  onAgentTurnError,
} from './agent-context-state.js';
import { formatUserFacingReply, looksLikeInternalToolArtifact } from './user-facing-reply.js';
import { completeDelegatedTask } from './delegated-tasks.js';

export function stripThinking(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();
}

/** Remove asterisks from reply so chat items never contain * or **. */
function stripAsterisks(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/\*\*/g, '').replace(/\*/g, '');
}

/**
 * Tool-loop budget. Defaults can be overridden via env vars for ops:
 *   PASTURE_MAX_TOOL_ROUNDS         (default 3)  — read-only / general turns
 *   PASTURE_MAX_TOOL_ROUNDS_WRITE   (default 10) — write turns get more headroom
 *   PASTURE_MAX_TOOL_CALL_RETRIES   (default 3)  — bad-arguments retry budget
 *   PASTURE_MAX_COMPLETENESS_RETRIES(default 2)  — synthesis retry budget
 *
 * Audit finding #23: previously these were module constants — operators had
 * no way to tune them without forking the file.
 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
const MAX_TOOL_ROUNDS = envInt('PASTURE_MAX_TOOL_ROUNDS', 3);
const MAX_TOOL_ROUNDS_WRITE = envInt('PASTURE_MAX_TOOL_ROUNDS_WRITE', 10);
const MAX_TOOL_CALL_RETRIES = envInt('PASTURE_MAX_TOOL_CALL_RETRIES', 3);
const MAX_COMPLETENESS_RETRIES = envInt('PASTURE_MAX_COMPLETENESS_RETRIES', 2);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FINAL_REPLY_POLICY = readFileSync(join(__dirname, 'templates', 'final-reply-policy.md'), 'utf8').trim();

function withFinalReplyPolicy(messages) {
  return [
    ...messages,
    { role: 'user', content: FINAL_REPLY_POLICY },
  ];
}

/**
 * Soft turn-level character budget across `messages`. Audit finding #21:
 * stacked system blocks + per-call full SKILL.md + accumulated tool output
 * could grow context unboundedly within a single turn. When we exceed this
 * budget, the oldest tool messages are replaced with a one-line summary so
 * the latest tool round still has room to breathe.
 *
 * Default 200K chars ~= 50K tokens — well under most provider limits but
 * generous enough that normal turns never trigger truncation.
 */
const MESSAGES_CHAR_BUDGET = envInt('PASTURE_MESSAGES_CHAR_BUDGET', 200_000);

export const TOOL_LOOP_LIMITS = Object.freeze({
  MAX_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS_WRITE,
  MAX_TOOL_CALL_RETRIES,
  MAX_COMPLETENESS_RETRIES,
  MESSAGES_CHAR_BUDGET,
});

/**
 * Total `content` chars across an OpenAI-shape `messages` array. Tool calls
 * (assistant.tool_calls[].function.arguments) and tool results both count.
 * Used to enforce MESSAGES_CHAR_BUDGET.
 *
 * @param {Array<{role: string, content?: string|null, tool_calls?: any[]}>} messages
 * @returns {number}
 */
export function messagesCharCount(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (m && typeof m.content === 'string') n += m.content.length;
    if (m && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const args = tc?.function?.arguments;
        if (typeof args === 'string') n += args.length;
      }
    }
  }
  return n;
}

/**
 * If `messages` exceeds the budget, replace the oldest tool-result messages
 * with a short placeholder until we're back under. Mutates `messages` in
 * place. Returns the number of messages that were truncated.
 *
 * Strategy:
 *   - Never touch the system message (index 0) or the most recent 4 messages
 *     (the LLM typically needs the immediate context to make sense of the
 *     current round).
 *   - Only role:'tool' messages are eligible to be replaced — they carry the
 *     bulk of the cost and have the lowest semantic value once acted on.
 *
 * @param {Array} messages
 * @param {number} budget
 * @param {(line: string) => void} [log]
 * @returns {number} count of messages truncated
 */
export function enforceMessagesBudget(messages, budget, log = null) {
  if (!Array.isArray(messages) || !Number.isFinite(budget) || budget <= 0) return 0;
  let truncated = 0;
  while (messagesCharCount(messages) > budget) {
    let idx = -1;
    for (let i = 1; i < messages.length - 4; i++) {
      const m = messages[i];
      if (m?.role === 'tool' && typeof m.content === 'string' && m.content.length > 200) {
        idx = i;
        break;
      }
    }
    if (idx < 0) break; // nothing further safe to truncate
    const original = messages[idx].content || '';
    messages[idx] = {
      ...messages[idx],
      content: `[earlier tool output truncated to fit context budget — ${original.length} chars elided]`,
    };
    truncated++;
    if (log) log(`[agent] truncated tool message #${idx} (${original.length} chars elided)`);
    if (truncated > 50) break; // hard safety: never loop forever
  }
  return truncated;
}

/** Tool names that constitute a persistent filesystem or GitHub mutation. */
const WRITE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'apply_patch_apply',
  'go_write_run',
  'github_create_branch',
  'github_post_comment',
  'github_create_pr',
  'github_merge_pr',
]);
const WRITE_SKILL_IDS = new Set(['write', 'edit', 'apply-patch', 'go-write']);

function isWriteToolCall(skillId, toolName) {
  if (WRITE_TOOL_NAMES.has(toolName)) return true;
  if (WRITE_SKILL_IDS.has(skillId)) return true;
  return false;
}

function writeAction(runArgs) {
  return (runArgs?.command || runArgs?.action || '').toString().trim().toLowerCase();
}

function argvList(runArgs) {
  return Array.isArray(runArgs?.argv)
    ? runArgs.argv.map((a) => String(a)).filter((a) => a.trim())
    : [];
}

function nonFlagArgs(argv) {
  return argv.filter((arg) => {
    const s = String(arg || '').trim();
    return s && s !== '--pasture-full-copy' && !s.startsWith('-');
  });
}

function verificationTarget(path, expectation, runArgs) {
  const p = typeof path === 'string' ? path.trim() : '';
  if (!p || p === '.') return null;
  const cwd = typeof runArgs?.cwd === 'string' && runArgs.cwd.trim() ? runArgs.cwd.trim() : '';
  return { path: p, expectation, cwd };
}

function addWriteVerificationTarget(targetMap, target) {
  if (!target?.path) return;
  const key = `${target.cwd || ''}\u0000${target.path}\u0000${target.expectation || 'exists'}`;
  targetMap.set(key, {
    path: target.path,
    expectation: target.expectation || 'exists',
    cwd: target.cwd || '',
  });
}

/** Extract actual filesystem targets for persistence verification. */
function collectWriteVerificationTargets(skillId, runArgs) {
  const targets = [];
  const add = (path, expectation = 'exists') => {
    const target = verificationTarget(path, expectation, runArgs);
    if (target) targets.push(target);
  };

  if (skillId === 'write' || skillId === 'edit' || skillId === 'apply-patch') {
    add(runArgs?.path, 'exists');
    return targets;
  }

  if (skillId !== 'go-write') return targets;

  const action = writeAction(runArgs);
  const args = nonFlagArgs(argvList(runArgs));
  if (!args.length) return targets;

  if (action === 'cp' || action === 'mv' || action === 'rsync') {
    add(args[args.length - 1], 'exists');
    return targets;
  }

  if (action === 'rm') {
    for (const path of args) add(path, 'absent');
    return targets;
  }

  if (action === 'chmod') {
    for (const path of args.slice(1)) add(path, 'exists');
    return targets;
  }

  if (action === 'mkdir' || action === 'touch') {
    for (const path of args) add(path, 'exists');
  }

  if (action === 'create_next_app') {
    add(runArgs?.path || runArgs?.projectPath || runArgs?.name || args[0], 'exists');
  }

  return targets;
}

async function buildFilesystemPersistenceVerification(ctx, targetMap) {
  const targets = [...targetMap.values()];
  if (targets.length === 0) return '';

  const verifyParts = [];
  for (const target of targets) {
    const args = { command: 'ls', argv: ['-la', target.path] };
    if (target.cwd) args.cwd = target.cwd;
    let lsResult = '';
    let observed = 'missing/unreadable';
    try {
      lsResult = await executeSkill('go-read', ctx, args);
      if (lsResult && parseSkillResult(lsResult).ok) observed = 'present/readable';
    } catch (err) {
      lsResult = JSON.stringify({ error: err?.message || String(err) });
    }
    const expected = target.expectation === 'absent'
      ? 'path should be absent after removal'
      : 'path should exist after the write operation';
    verifyParts.push(
      `Target: ${target.path}${target.cwd ? ` (cwd: ${target.cwd})` : ''}\n` +
      `Expected: ${expected}\n` +
      `Observed: ${observed}\n` +
      `${String(lsResult || '').trim() || '(empty result)'}`
    );
  }

  return (
    `Filesystem persistence verification (actual state after write operations):\n` +
    `${verifyParts.join('\n\n')}\n\n` +
    `Use this as ground truth before answering. If it does not confirm the intended filesystem change, do not say the task is complete. ` +
    `If tools are still available, redo the change and verify again; otherwise say the change was not verified. ` +
    `For removals, missing/unreadable can confirm deletion only when the target was expected to be absent.`
  );
}

function summarizeText(text, maxLen = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/** Extract image file path from user message when it contains "Image file: /path/to/file.jpg. " (Telegram/WhatsApp upload). */
function extractImagePathFromMessage(text) {
  if (!text || typeof text !== 'string') return null;
  // Path may contain dots (e.g. .jpg); the trailing ". " is end of sentence, so take path up to last ".\s" or ".$"
  const match = text.match(/Image file:\s*(.+)\.(\s|$)/s);
  const path = match ? match[1].trim() : null;
  if (!path) return null;
  return path;
}

/**
 * Get the most recent image path from chat history (last user message containing "Image file: ...").
 * Only returns a path if the file still exists on disk so vision can use it.
 * @param {Array<{ role: string, content: string }>} historyMessages
 * @returns {string|null}
 */
function getLastImagePathFromHistory(historyMessages) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return null;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    if (msg?.role !== 'user' || typeof msg.content !== 'string') continue;
    const path = extractImagePathFromMessage(msg.content);
    if (path && existsSync(path)) return path;
  }
  return null;
}

/** True if runArgs already has an image source for vision (image, url, path, file, filePath, imagePath). */
function hasVisionImageArg(runArgs) {
  if (!runArgs || typeof runArgs !== 'object') return false;
  const v = (key) => runArgs[key] != null && String(runArgs[key]).trim() !== '';
  return v('image') || v('url') || v('path') || v('file') || v('filePath') || v('imagePath');
}

/** Valid tool names (from tools array). Used when we have action-based tools. */
function getValidToolNames(tools) {
  if (!Array.isArray(tools)) return new Set();
  return new Set(tools.map((t) => t?.function?.name).filter(Boolean));
}

/** One-line status for dashboard chat while filesystem-related tools run (write, cp, mv, rm, …). */
function fileToolProgressLine(skillId, runArgs, _toolCallName) {
  const id = skillId && String(skillId).trim();
  if (!id) return '';
  const path = runArgs?.path != null ? String(runArgs.path).trim() : '';
  const action = (runArgs?.command || runArgs?.action || '').toString().trim().toLowerCase();
  const argv = Array.isArray(runArgs?.argv) ? runArgs.argv.map((a) => String(a)) : [];

  if (id === 'write' && path) return `Writing ${path}`;
  if (id === 'edit' && path) return `Editing ${path}`;
  if (id === 'apply-patch' && path) return `Applying patch to ${path}`;
  if (id === 'read' && path) return `Reading ${path}`;
  if (id === 'go-write' && action) {
    const tail = argv.length ? argv.join(' ') : '';
    return tail ? `${action}: ${tail}` : action;
  }
  if (id === 'go-read' && action) {
    const tail = argv.length ? argv.join(' ') : '';
    return tail ? `${action}: ${tail}` : action;
  }
  if (id === 'core' && action && ['cp', 'mv', 'rm', 'touch', 'mkdir', 'chmod', 'rsync'].includes(action)) {
    const tail = argv.length ? argv.join(' ') : '';
    return tail ? `${action}: ${tail}` : action;
  }
  return '';
}

/** Validate tool call arguments: parseable JSON; run_skill must have "skill"; other tools must be in valid names. */
function validateToolCalls(toolCalls, tools) {
  if (!toolCalls || toolCalls.length === 0) return true;
  const validNames = getValidToolNames(tools);
  for (const tc of toolCalls) {
    let payload = {};
    try {
      payload = JSON.parse(tc.arguments || '{}');
    } catch {
      return false;
    }
    if (tc.name === 'run_skill') {
      const skillId = payload.skill && String(payload.skill).trim();
      if (!skillId) return false;
    } else {
      if (!validNames.has(tc.name)) return false;
    }
  }
  return true;
}

/**
 * Run one agent turn: messages -> optional tool calls -> final text to send.
 * @param {object} opts
 * @param {string} opts.userText - User message (or cron job message).
 * @param {object} opts.ctx - { storePath, jid, workspaceDir, scheduleOneShot, startCron }
 * @param {string} opts.systemPrompt - Role-only system prompt (soul, Who am I, My human, timezone). Skill descriptions are in the run_skill tool, not here.
 * @param {Array} opts.tools - Skills: run_skill tool array from getSkillContext() (compact list in tool description).
 * @param {Array<{ role: string, content: string }>} [opts.historyMessages] - Optional prior exchanges for context (default []).
 * @param {(skillId: string) => string} [opts.getFullSkillDoc] - When a skill is called, inject full skill doc into the tool result (from getSkillContext()).
 * @param {(toolName: string) => { skillId: string, action: string, toolName?: string } | null} [opts.resolveToolName] - Resolve action tool name to skillId + action (from getSkillContext()).
 * @param {(line: string) => void} [opts.onToolProgress] - Called before each filesystem-related skill runs (e.g. dashboard live steps).
 * @returns {Promise<{ textToSend: string }>}
 */
export async function runAgentTurn({
  userText,
  ctx,
  systemPrompt,
  tools,
  historyMessages = [],
  getFullSkillDoc = null,
  resolveToolName = null,
  onToolProgress = null,
  abortSignal = null,
}) {
  const turnStartedAt = Date.now();
  const currentAgentId = ctx?.agentId || 'main';
  const userPreview = summarizeText(userText, 100);
  logTeamActivity({
    type: 'turn_start',
    agentId: currentAgentId,
    depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
    jid: ctx?.jid || '',
    missionId: ctx?.missionId || '',
    message: userPreview || 'New request',
    details: buildTurnStartInboxDetails({ userText, ctx }),
  });
  onAgentTurnStart({ agentId: currentAgentId, userText, ctx });
  const finishTurnState = (status, message) => {
    logTeamActivity({
      type: 'turn_done',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      missionId: ctx?.missionId || '',
      status,
      message,
    });
    onAgentTurnDone({ agentId: currentAgentId, status });
  };
  try {
  const llmOptions = ctx?.agentId ? { agentId: ctx.agentId } : {};
  const agentLlmOptions = (purpose) => ({ ...llmOptions, purpose });
  const useTools = Array.isArray(tools) && tools.length > 0;
  const toolsToUse = useTools ? tools : [];
  const emitStep = typeof onToolProgress === 'function' ? onToolProgress : null;
  // Per AGENTS.md: there are no regex-based "fast path" bypasses for write /
  // edit / home-assistant intents. The turn-router LLM call routes these
  // requests to the right skill via the normal tool loop below.
  const systemPromptWithReplyPolicy = systemPrompt.includes('# Final Reply Policy')
    ? systemPrompt
    : `${systemPrompt}\n\n${FINAL_REPLY_POLICY}`;
  let messages = [
    { role: 'system', content: systemPromptWithReplyPolicy },
    ...historyMessages,
    { role: 'user', content: userText },
  ];
  let finalContent = '';
  let cronListResult = null;
  let searchResult = null;
  let browseResult = null;
  let visionResult = null;
  let agentSendResult = null;
  let imageReplyPath = null;
  let imageReplyCaption = null;
  let lastToolResult = null; // successful result from core, read, etc. — used when LLM doesn't echo it
  let lastToolError = null; // user-friendly error from the most recent failed tool call
  let voiceReplyText = null;
  let lastRoundHadToolError = false;
  /** Delegated tasks (review_ready) to auto-complete when this turn finishes cleanly. */
  const reviewReadyDelegations = [];
  const skillsCalled = [];
  let hadWriteOp = false;
  let pendingPostWriteSynthesis = false;
  const writeVerificationTargets = new Map();
  const pendingWriteVerificationTargets = new Map();
  /** True iff the for-loop exited because every round was used (i.e. the
   *  LLM kept asking for tools and we ran out of budget). Distinct from
   *  natural exit (no more tool calls) and tool-call-validation exhaustion. */
  let roundsExhausted = false;
  /** True iff the caller's abortSignal fired between tool rounds. Audit
   *  finding #14: previously cancelBackgroundTask only flipped a JSON status
   *  field; the in-flight runAgentTurn kept running. Now we cooperatively
   *  exit at the next round boundary. */
  let wasCancelled = false;
  /** Skill ids whose full SKILL.md has already been injected this turn.
   *  Audit finding #22: previously the doc was appended on EVERY tool call,
   *  which inflates context for multi-call skills (read called N times,
   *  memory_search + memory_get, etc.). One injection per skill is enough. */
  const skillDocsInjected = new Set();

  const synthesizeAfterPersistentWrites = async () => {
    if (!pendingPostWriteSynthesis) return;
    try {
      const verificationContent = await buildFilesystemPersistenceVerification(ctx, writeVerificationTargets);
      pendingWriteVerificationTargets.clear();
      if (verificationContent) {
        messages.push({
          role: 'user',
          content: verificationContent,
        });
      }
      // Audit finding #20: previously this verification message was just
      // appended to `messages` and depended on a downstream synthesis path
      // that only fires when finalContent is empty. As a result, write
      // turns could report "Done. Wrote 3 files" while disk showed none of
      // them. Always run one no-tools synthesis pass after verification so
      // the user-facing reply is grounded in the actual persisted state.
      try {
        const synthesized = await chatWithTools(
          withFinalReplyPolicy(messages),
          [],
          agentLlmOptions('agent_turn_post_write_synthesis')
        );
        const reply = synthesized?.content && stripThinking(synthesized.content).trim();
        if (reply) finalContent = reply;
      } catch (_) {}
    } catch (_) {
    } finally {
      pendingPostWriteSynthesis = false;
    }
  };

  for (let round = 0; round <= (hadWriteOp ? MAX_TOOL_ROUNDS_WRITE : MAX_TOOL_ROUNDS); round++) {
    if (abortSignal && abortSignal.aborted) {
      wasCancelled = true;
      break;
    }
    if (!useTools) {
      const rawReply = await llmChat(messages, agentLlmOptions('agent_turn_chat'));
      finalContent = stripThinking(rawReply);
      break;
    }
    let content;
    let toolCalls;
    let toolCallRetries = 0;
    while (toolCallRetries <= MAX_TOOL_CALL_RETRIES) {
      const response = await chatWithTools(messages, toolsToUse, agentLlmOptions(`agent_turn_tools_r${round}`));
      content = response.content;
      toolCalls = response.toolCalls;
      if (!toolCalls || toolCalls.length === 0) {
        if (round === 0 && toolsToUse.length > 0) {
          console.log('[path] LLM returned no tool calls (tools were available:', toolsToUse.length, ')');
        }
        finalContent = content || '';
        break;
      }
      if (validateToolCalls(toolCalls, toolsToUse)) break;
      if (toolCallRetries >= MAX_TOOL_CALL_RETRIES) {
        // Retry budget exhausted with still-invalid tool calls. Don't execute
        // the bad batch — that wastes a round and pollutes tool messages.
        // Drop the calls; the outer loop exits and the final-reply path
        // surfaces lastToolError to the user.
        console.log(
          '[agent] tool-call validation exhausted after',
          MAX_TOOL_CALL_RETRIES,
          'retries; aborting tool loop.'
        );
        lastRoundHadToolError = true;
        lastToolError =
          'I tried to use a tool but kept producing invalid arguments. Please rephrase or simplify.';
        toolCalls = null;
        finalContent = content || '';
        break;
      }
      toolCallRetries++;
      console.log('[agent] invalid tool call arguments, retry', toolCallRetries, 'of', MAX_TOOL_CALL_RETRIES);
      messages = messages.concat({
        role: 'user',
        content: 'Your previous tool call had invalid or malformed arguments (missing or bad JSON, missing "skill" for run_skill, or unknown tool name). Use the correct tool with valid parameters.',
      });
    }
    if (!toolCalls || toolCalls.length === 0) break;
    const assistantMsg = {
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
    messages = messages.concat(assistantMsg);
    lastRoundHadToolError = false;
    for (const tc of toolCalls) {
      let payload = {};
      try {
        payload = JSON.parse(tc.arguments || '{}');
      } catch {
        payload = {};
      }
      let skillId;
      let runArgs;
      let toolName;
      const resolved = typeof resolveToolName === 'function' ? resolveToolName(tc.name) : null;
      if (resolved) {
        skillId = resolved.skillId;
        runArgs = typeof payload === 'object' && payload !== null ? { ...payload } : {};
        if (resolved.action === 'run') {
          const innerAction = runArgs.action || runArgs.command;
          if (innerAction && String(innerAction).trim()) {
            runArgs.action = String(innerAction).trim();
          }
        } else {
          runArgs.action = resolved.action;
        }
        toolName = resolved.toolName || undefined;
      } else {
        skillId = payload.skill && String(payload.skill).trim();
        runArgs = payload.arguments && typeof payload.arguments === 'object' ? { ...payload.arguments } : {};
        if (payload.command && String(payload.command).trim()) runArgs.action = String(payload.command).trim();
        toolName = skillId === 'memory' ? (runArgs.tool || 'memory_search') : undefined;
        if (skillId === 'memory' && (toolName === 'memory_search') && !(runArgs.query && String(runArgs.query).trim())) {
          const q = (payload.query && String(payload.query).trim()) || (payload.q && String(payload.q).trim()) || '';
          if (q) runArgs.query = q;
        }
      }
      if (skillId === 'vision' && !hasVisionImageArg(runArgs)) {
        const action = (runArgs?.action && String(runArgs.action).trim().toLowerCase()) || 'describe';
        if (action !== 'generate') {
          const extractedPath = extractImagePathFromMessage(userText) || getLastImagePathFromHistory(historyMessages);
          if (extractedPath) runArgs.image = extractedPath;
        }
      }
      const action = runArgs?.action && String(runArgs.action).trim().toLowerCase();
      if (!skillId) {
        const errContent = JSON.stringify({ error: 'run_skill requires "skill" and "arguments".' });
        lastRoundHadToolError = true;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: errContent });
        continue;
      }
      console.log('[agent] skill called:', skillId);
      onAgentSkillStart({ agentId: currentAgentId, skillId });
      skillsCalled.push(skillId);
      const pl = fileToolProgressLine(skillId, runArgs, tc.name);
      const toolStart = Date.now();
      logTeamActivity({
        type: 'skill_start',
        agentId: ctx?.agentId || 'main',
        skillId,
        action: runArgs?.action || '',
        depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
        jid: ctx?.jid || '',
        message: pl || '',
      });
      if (emitStep && pl) {
        try {
          emitStep(pl);
        } catch (_) {}
      }
      const result = await executeSkill(skillId, ctx, runArgs, toolName);
      const skillRes = parseSkillResult(result);
      const isToolError = !skillRes.ok;
      const toolMessage = isToolError
        ? skillRes.error || `Skill ${skillId} failed`
        : `Skill ${skillId} finished in ${Date.now() - toolStart}ms`;
      logTeamActivity({
        type: isToolError ? 'skill_error' : 'skill_done',
        agentId: ctx?.agentId || 'main',
        skillId,
        action: runArgs?.action || '',
        status: isToolError ? 'error' : 'ok',
        depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
        jid: ctx?.jid || '',
        message: toolMessage,
      });
      logTiming({
        type: 'skill_end',
        phase: 'skill',
        purpose: skillId,
        agentId: currentAgentId,
        durationMs: Date.now() - toolStart,
        status: isToolError ? 'error' : 'ok',
        detail: { action: runArgs?.action || '', toolName: tc.name || '' },
      });
      if (isToolError) {
        const skillErrMsg = skillRes.error || toolMessage;
        onAgentSkillError({
          agentId: currentAgentId,
          skillId,
          message: skillErrMsg,
        });
        lastToolError = skillErrMsg;
        lastRoundHadToolError = true;
      }
      // Track write operations for extended round limit and persistence verification.
      if (!isToolError && isWriteToolCall(skillId, tc.name)) {
        hadWriteOp = true;
        pendingPostWriteSynthesis = true;
        for (const target of collectWriteVerificationTargets(skillId, runArgs)) {
          addWriteVerificationTarget(writeVerificationTargets, target);
          addWriteVerificationTarget(pendingWriteVerificationTargets, target);
        }
      }
      if (skillId === 'cron' && action === 'list' && result && typeof result === 'string' && !isToolError) {
        cronListResult = result;
      }
      if (skillId === 'search' && result && typeof result === 'string') {
        const newHasHeadlines = result.includes('Top news / headlines');
        const newIsError = isToolError || result.includes('The search engine returned an error');
        const currentIsError = !searchResult || !parseSkillResult(searchResult).ok || searchResult.includes('The search engine returned an error');
        if (!searchResult || newHasHeadlines || (currentIsError && !newIsError)) searchResult = result;
      }
      if (skillId === 'browse' && !isToolError && result && typeof result === 'string') {
        browseResult = result;
      }
      if (skillId === 'vision' && !isToolError && result && typeof result === 'string') {
        visionResult = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed?.imageReply?.path) {
            imageReplyPath = parsed.imageReply.path;
            imageReplyCaption = (parsed.imageReply.caption && String(parsed.imageReply.caption).trim()) || parsed.message || '';
          }
        } catch (_) {}
      }
      if (skillId === 'agent-send' && result && typeof result === 'string' && !isToolError) {
        try {
          const parsed = JSON.parse(result);
          if (parsed?.reply) agentSendResult = parsed;
          if (
            parsed?.delegatedTask
            && parsed?.delegatedTaskStatus === 'review_ready'
          ) {
            // Coordinator now has the deliverable. Mark the task done at
            // turn-end so it doesn't accumulate in the delegated-tasks
            // context block forever (audit finding #18).
            reviewReadyDelegations.push({
              delegatedTask: parsed.delegatedTask,
              replySummary: String(parsed.reply || '').slice(0, 400),
            });
          }
        } catch (_) {}
      }
      if (!isToolError && result && typeof result === 'string' && result.trim()) {
        lastToolResult = result;
      }
      if (skillId === 'speech' && action === 'reply_as_voice' && !isToolError && runArgs.text && typeof runArgs.text === 'string') {
        voiceReplyText = String(runArgs.text).trim();
      }
      let toolContent = result;
      if (typeof getFullSkillDoc === 'function' && !skillDocsInjected.has(skillId)) {
        const fullDoc = getFullSkillDoc(skillId);
        if (fullDoc) {
          toolContent = result + '\n\n---\nFull skill doc for ' + skillId + ':\n' + fullDoc;
          skillDocsInjected.add(skillId);
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
    }
    if (pendingWriteVerificationTargets.size > 0) {
      const verificationContent = await buildFilesystemPersistenceVerification(ctx, pendingWriteVerificationTargets);
      pendingWriteVerificationTargets.clear();
      if (verificationContent) {
        messages.push({
          role: 'user',
          content: verificationContent,
        });
      }
    }

    // Audit finding #21: cap turn-level context. If accumulated tool output +
    // skill docs + system blocks exceed MESSAGES_CHAR_BUDGET, replace the
    // oldest tool-result messages with a short placeholder so the next
    // round still has room. Logged via a tool_round_budget_truncate event.
    const truncCount = enforceMessagesBudget(messages, MESSAGES_CHAR_BUDGET, (line) => console.log(line));
    if (truncCount > 0) {
      logTeamActivity({
        type: 'tool_round_budget_truncate',
        agentId: currentAgentId,
        depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
        jid: ctx?.jid || '',
        missionId: ctx?.missionId || '',
        status: 'ok',
        message: `Truncated ${truncCount} older tool message${truncCount === 1 ? '' : 's'} to fit ${MESSAGES_CHAR_BUDGET} char budget.`,
      });
    }
    // If we just executed tools on the last allowed round, the for-loop is
    // about to exit because of its bound, not because the LLM was satisfied.
    // Mark exhausted so the final-reply path can surface the cap explicitly.
    if (round === (hadWriteOp ? MAX_TOOL_ROUNDS_WRITE : MAX_TOOL_ROUNDS)) {
      roundsExhausted = true;
    }
  }

  // Post-write verification: run a final synthesis pass so the user-facing
  // reply is grounded in persisted filesystem/GitHub state, not a stale claim.
  await synthesizeAfterPersistentWrites();

  if (useTools && !stripThinking(finalContent).trim() && lastRoundHadToolError) {
    try {
      const { content: clarification } = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions('agent_turn_tool_error_clarify'));
      const text = clarification && stripThinking(clarification).trim();
      if (text) finalContent = text;
    } catch (_) {}
  }
  if (searchResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions('agent_turn_search_synthesis'));
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  if (browseResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions('agent_turn_browse_synthesis'));
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  if (visionResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions('agent_turn_vision_synthesis'));
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  const looksLikeBrushOff = (s) => /^(Done\.?|Anything else\?|Done\.\s*Anything else\?)\s*$/i.test((s || '').trim());
  if (lastToolResult && (!stripThinking(finalContent).trim() || looksLikeBrushOff(finalContent))) {
    try {
      const { content: synthesized } = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions('agent_turn_tool_result_synthesis'));
      const reply = synthesized && stripThinking(synthesized).trim();
      if (reply && !looksLikeBrushOff(reply)) finalContent = reply;
    } catch (_) {}
  }

  // Completeness probe: if tools were used and we have a non-empty answer, check whether
  // all parts of the user query were actually addressed. The probe distinguishes between
  // "skipped" (assistant assumed it couldn't, never tried) and "unavailable" (tried, data
  // genuinely doesn't exist). Only "skipped" items get a retry — no point retrying
  // something the tools already confirmed doesn't exist.
  // Retry replaces finalContent (not appends) to avoid duplicate blocks in the reply.
  // Bounded by MAX_COMPLETENESS_RETRIES — not one retry per item.
  if (skillsCalled.length > 0 && useTools && stripThinking(finalContent).trim()) {
    for (let cr = 0; cr < MAX_COMPLETENESS_RETRIES; cr++) {
      let probeComplete = true;
      let probeMissing = null;
      try {
        const toolsCalledLine = skillsCalled.length > 0
          ? `Tools already called: ${[...new Set(skillsCalled)].join(', ')}. Any missing item that maps to one of these tools is "unavailable", not "skipped".\n\n`
          : '';
        const probeReply = await llmChat([
          {
            role: 'system',
            content: 'You are a quality checker. Answer only with valid JSON, no prose.',
          },
          {
            role: 'user',
            content:
              `User asked: "${userText}"\n\n` +
              toolsCalledLine +
              `Assistant answered: "${stripThinking(finalContent).trim()}"\n\n` +
              `For any unanswered part, was it skipped (assistant assumed it couldn't be done without trying) or genuinely unavailable (assistant tried with tools and data doesn't exist)?\n` +
              `IMPORTANT: Creating dashboard missions/tasks/projects requires explicit user approval (yes / go ahead / create it). ` +
              `If the user only stated a mission (e.g. "increase sign ups") and did not approve creation, do NOT list "create mission" or "create tasks on dashboard" as missing — treat planning as done and approval as pending.\n` +
              `Reply with exactly one of:\n` +
              `{ "complete": true }\n` +
              `{ "complete": false, "reason": "skipped", "missing": ["<item 1>", "<item 2>"] }\n` +
              `{ "complete": false, "reason": "unavailable" }`,
          },
        ], agentLlmOptions('agent_turn_completeness_probe'));
        const probe = JSON.parse(stripThinking(probeReply || '').trim());
        probeComplete = !probe || probe.complete !== false;
        if (!probeComplete) {
          if (probe.reason === 'unavailable') break; // tried and failed — don't waste a retry
          probeMissing = Array.isArray(probe?.missing)
            ? probe.missing.filter(Boolean).join(', ')
            : (typeof probe?.missing === 'string' ? probe.missing.trim() : null);
        }
      } catch (_) { break; }
      if (probeComplete || !probeMissing) break;

      console.log('[agent] completeness probe (attempt', cr + 1, 'of', MAX_COMPLETENESS_RETRIES, '): missing:', probeMissing);
      const approvalGuard = /create mission|create tasks|dashboard via project-workflow|apply_plan|apply_setup/i.test(probeMissing || '');
      if (approvalGuard) {
        console.log('[agent] completeness probe: skipping retry — dashboard writes need explicit user approval');
        break;
      }
      messages.push({
        role: 'user',
        content: `You didn't answer all parts of the question. Missing: "${probeMissing}". Use your tools to answer ALL missing parts. Keep the final user reply concise; do not describe this completeness check or list tool attempts. Do NOT call project-workflow apply_plan or apply_setup unless the user's message explicitly approved creation (yes / go ahead / create it).`,
      });

      // Execute one tool round for the missing parts. The LLM can fire multiple parallel
      // tool calls here (one per missing item), so a single retry round covers all gaps.
      // Replace finalContent rather than appending to avoid duplicate answer blocks.
      //
      // Audit finding #10: the completeness retry tool dispatch must reuse the
      // same observability hooks (skill_start / skill_done / skill_error / logTiming),
      // full skill-doc injection, and error envelope as the main loop. The previous
      // shorthand here skipped all of those, so retried tool calls were invisible
      // to team activity and metrics.
      try {
        const retryResp = await chatWithTools(messages, toolsToUse, agentLlmOptions(`agent_turn_completeness_retry_r${cr}`));
        if (retryResp.toolCalls?.length) {
          messages.push({
            role: 'assistant',
            content: retryResp.content || null,
            tool_calls: retryResp.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          for (const tc of retryResp.toolCalls) {
            let tcPayload = {};
            try { tcPayload = JSON.parse(tc.arguments || '{}'); } catch (_) {}
            const tcResolved = typeof resolveToolName === 'function' ? resolveToolName(tc.name) : null;
            let tcSkillId, tcRunArgs;
            if (tcResolved) {
              tcSkillId = tcResolved.skillId;
              tcRunArgs = { ...tcPayload };
              if (tcResolved.action === 'run') {
                const innerAction = tcRunArgs.action || tcRunArgs.command;
                if (innerAction && String(innerAction).trim()) {
                  tcRunArgs.action = String(innerAction).trim();
                }
              } else {
                tcRunArgs.action = tcResolved.action;
              }
            } else {
              tcSkillId = tcPayload.skill && String(tcPayload.skill).trim();
              tcRunArgs = tcPayload.arguments && typeof tcPayload.arguments === 'object' ? { ...tcPayload.arguments } : {};
              if (tcPayload.command) tcRunArgs.action = String(tcPayload.command).trim();
            }
            if (!tcSkillId) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'missing skill' }) });
              lastRoundHadToolError = true;
              continue;
            }
            const tcRetryStart = Date.now();
            onAgentSkillStart({ agentId: currentAgentId, skillId: tcSkillId });
            skillsCalled.push(tcSkillId);
            const tcResult = await executeSkill(tcSkillId, ctx, tcRunArgs);
            const tcRetrySkillRes = parseSkillResult(tcResult);
            const tcRetryIsError = !tcRetrySkillRes.ok;
            const tcRetryMessage = tcRetryIsError
              ? tcRetrySkillRes.error || `Skill ${tcSkillId} failed`
              : `Skill ${tcSkillId} finished in ${Date.now() - tcRetryStart}ms (completeness retry)`;
            logTeamActivity({
              type: tcRetryIsError ? 'skill_error' : 'skill_done',
              agentId: ctx?.agentId || 'main',
              skillId: tcSkillId,
              action: tcRunArgs?.action || '',
              status: tcRetryIsError ? 'error' : 'ok',
              depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
              jid: ctx?.jid || '',
              message: tcRetryMessage,
            });
            logTiming({
              type: 'skill_end',
              phase: 'skill',
              purpose: tcSkillId,
              agentId: currentAgentId,
              durationMs: Date.now() - tcRetryStart,
              status: tcRetryIsError ? 'error' : 'ok',
              detail: { action: tcRunArgs?.action || '', toolName: tc.name || '', completenessRetry: true },
            });
            if (tcRetryIsError) {
              const skillErrMsg = tcRetrySkillRes.error || tcRetryMessage;
              onAgentSkillError({ agentId: currentAgentId, skillId: tcSkillId, message: skillErrMsg });
              lastToolError = skillErrMsg;
              lastRoundHadToolError = true;
            } else if (typeof tcResult === 'string' && tcResult.trim()) {
              lastToolResult = tcResult;
            }
            // Track write operations the same way the main loop does so
            // persistence verification can see them too.
            if (!tcRetryIsError && isWriteToolCall(tcSkillId, tc.name)) {
              hadWriteOp = true;
              pendingPostWriteSynthesis = true;
              for (const target of collectWriteVerificationTargets(tcSkillId, tcRunArgs)) {
                addWriteVerificationTarget(writeVerificationTargets, target);
                addWriteVerificationTarget(pendingWriteVerificationTargets, target);
              }
            }
            // Inject the full skill doc once per turn (dedupe via the same set).
            let tcContent = tcResult;
            if (typeof getFullSkillDoc === 'function' && !skillDocsInjected.has(tcSkillId)) {
              const fullDoc = getFullSkillDoc(tcSkillId);
              if (fullDoc) {
                tcContent = tcResult + '\n\n---\nFull skill doc for ' + tcSkillId + ':\n' + fullDoc;
                skillDocsInjected.add(tcSkillId);
              }
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: tcContent });
          }
          const synthesis = await chatWithTools(withFinalReplyPolicy(messages), [], agentLlmOptions(`agent_turn_completeness_synthesis_r${cr}`));
          const synthesized = synthesis?.content && stripThinking(synthesis.content).trim();
          if (synthesized && !looksLikeBrushOff(synthesized)) {
            finalContent = synthesized;
          }
        } else {
          const retryText = retryResp?.content && stripThinking(retryResp.content).trim();
          if (retryText && !looksLikeBrushOff(retryText)) {
            finalContent = retryText;
          }
        }
      } catch (_) { break; }
    }
  }

  // Completeness retries can perform writes after the first post-write
  // synthesis pass, so run the persistence guardrail again if needed.
  await synthesizeAfterPersistentWrites();

  const trimmedFinal = stripThinking(finalContent).trim();
  const looksLikeToolCallJson = looksLikeInternalToolArtifact(trimmedFinal);
  const humanFinal = formatUserFacingReply(trimmedFinal);
  const hasNumberedHeadlines = /\n\d+\.\s+.+/.test(trimmedFinal) || /^\d+\.\s+.+/.test(trimmedFinal);
  const searchHasNewsBlock = searchResult && searchResult.includes('Top news / headlines');
  const agentReplyText = agentSendResult?.reply && String(agentSendResult.reply).trim();
  const finalIncludesAgentReply = agentReplyText && trimmedFinal.includes(agentReplyText.slice(0, Math.min(40, agentReplyText.length)));
  const useAgentSendAsReply = agentSendResult && agentReplyText && (
    !trimmedFinal || !finalIncludesAgentReply || /\b(sent to|asked|messaged)\b/i.test(trimmedFinal)
  );
  const useSearchResultAsReply = !useAgentSendAsReply && searchResult && searchResult.trim() && (
    !trimmedFinal ||
    looksLikeToolCallJson ||
    (searchHasNewsBlock && !hasNumberedHeadlines)
  );

  const withPrefix = (s) => (s && /^\[Pasture\]\s*/i.test(s.trim()) ? s.trim() : '[Pasture] ' + (s || '').trim());
  let textToSend;
  let replySource = '';
  if (useAgentSendAsReply) {
    replySource = 'agent-send';
    textToSend = withPrefix(formatUserFacingReply(agentReplyText));
  } else if (useSearchResultAsReply) {
    replySource = looksLikeToolCallJson ? 'search-fallback-after-internal-artifact' : 'search';
    let reply = searchResult.trim();
    try {
      const parsed = JSON.parse(reply);
      if (parsed && typeof parsed.error === 'string') {
        const err = parsed.error;
        if (/executable doesn't exist|doesn't exist at|playwright.*install/i.test(err)) {
          reply = "I couldn't run the search because the browser isn't set up. Run: pnpm exec playwright install";
        } else {
          reply = toUserMessage(err);
        }
      }
    } catch (_) {}
    reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    textToSend = withPrefix(reply);
  } else if (humanFinal) {
    replySource = 'final-content';
    textToSend = withPrefix(humanFinal);
  } else if (cronListResult && cronListResult.trim()) {
    replySource = 'cron-list';
    textToSend = withPrefix(cronListResult.trim());
  } else if (searchResult && searchResult.trim()) {
    replySource = 'search';
    let reply = searchResult.trim();
    try {
      const parsed = JSON.parse(reply);
      if (parsed && typeof parsed.error === 'string') {
        const err = parsed.error;
        if (/executable doesn't exist|doesn't exist at|playwright.*install/i.test(err)) {
          reply = "I couldn't run the search because the browser isn't set up. Run: pnpm exec playwright install";
        } else {
          reply = toUserMessage(err);
        }
      }
    } catch (_) {}
    reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    textToSend = withPrefix(reply);
  } else if (browseResult && browseResult.trim()) {
    replySource = 'browse';
    let reply = browseResult.trim();
    try {
      const parsed = JSON.parse(reply);
      if (parsed && typeof parsed.error === 'string') {
        const err = parsed.error;
        if (/executable doesn't exist|doesn't exist at|playwright.*install/i.test(err)) {
          reply = "I couldn't run the browser because Playwright isn't set up. Run: pnpm exec playwright install";
        } else {
          reply = toUserMessage(err);
        }
      }
    } catch (_) {}
    reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    textToSend = withPrefix(reply);
  } else if (visionResult && visionResult.trim()) {
    replySource = imageReplyPath ? 'vision-image' : 'vision';
    let reply = visionResult.trim();
    if (imageReplyPath) {
      reply = (imageReplyCaption && String(imageReplyCaption).trim())
        ? imageReplyCaption.slice(0, 2000) + (imageReplyCaption.length > 2000 ? '…' : '')
        : "Here's the image.";
    } else {
      try {
        const parsed = JSON.parse(reply);
        if (parsed && typeof parsed.error === 'string') {
          reply = toUserMessage(parsed.error);
        }
      } catch (_) {}
      reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    }
    textToSend = withPrefix(reply);
  } else if (lastToolResult && parseSkillResult(lastToolResult).ok) {
    replySource = 'last-tool-result';
    let reply = lastToolResult.trim();
    reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    textToSend = withPrefix(reply);
  } else if (wasCancelled) {
    replySource = 'cancelled';
    textToSend = withPrefix("Cancelled.");
  } else if (lastRoundHadToolError && lastToolError) {
    replySource = 'tool-error';
    textToSend = withPrefix(toUserMessage(lastToolError));
  } else if (lastRoundHadToolError) {
    replySource = 'tool-error-generic';
    textToSend = withPrefix("Something went wrong handling that. Please try again.");
  } else if (roundsExhausted) {
    replySource = 'tool-round-cap';
    // We ran the full tool-round budget and the LLM still wanted more.
    // Tell the user instead of pretending we're done.
    textToSend = withPrefix(
      `I ran out of tool rounds before finishing this. Try splitting it into smaller steps, or set PASTURE_MAX_TOOL_ROUNDS higher.`
    );
  } else {
    replySource = 'empty-fallback';
    textToSend = '[Pasture] Done. Anything else?';
  }
  if (roundsExhausted) {
    logTeamActivity({
      type: 'tool_round_cap_hit',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      missionId: ctx?.missionId || '',
      status: 'error',
      message: `Hit ${hadWriteOp ? MAX_TOOL_ROUNDS_WRITE : MAX_TOOL_ROUNDS} tool round cap (${hadWriteOp ? 'write' : 'read'}); ${skillsCalled.length} skill${skillsCalled.length === 1 ? '' : 's'} ran.`,
    });
  }
  const body = textToSend.replace(/^\[Pasture\]\s*/i, '').trim();
  const bodyResult = parseSkillResult(body);
  if (looksLikeInternalToolArtifact(body)) {
    replySource = 'internal-artifact-suppressed';
    textToSend = withPrefix(
      'I could not safely format the final response because it contained an internal tool payload.'
    );
  } else if (!bodyResult.ok) {
    replySource = 'skill-error-envelope';
    textToSend = withPrefix(bodyResult.error ? toUserMessage(bodyResult.error) : 'Something went wrong handling that. Please try again.');
  }
  console.log('[agent] reply resolution', JSON.stringify({
    source: replySource,
    internalArtifactDetected: looksLikeToolCallJson || looksLikeInternalToolArtifact(body),
    finalContentLength: trimmedFinal.length,
    textToSendLength: String(textToSend || '').length,
    skillsCalledCount: skillsCalled.length,
    hadWriteOp,
    roundsExhausted,
    lastRoundHadToolError,
  }));
  const turnStatus = wasCancelled
    ? 'cancelled'
    : (lastRoundHadToolError || roundsExhausted ? 'error' : 'ok');
  logTeamActivity({
    type: 'turn_done',
    agentId: currentAgentId,
    depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
    jid: ctx?.jid || '',
    missionId: ctx?.missionId || '',
    status: turnStatus,
    message: `Handled in ${Date.now() - turnStartedAt}ms using ${skillsCalled.length} skill${skillsCalled.length === 1 ? '' : 's'}${turnStatus === 'error' ? ' (with tool errors)' : ''}.`,
    details: buildTurnDoneInboxDetails({ textToSend, skillsCalled, ctx }),
  });
  try {
    const originalUserText = String(ctx?._originalUserText || userText || '').trim();
    if (!/^\[Retry with (tools|search)\]/i.test(originalUserText)) {
      syncTurnToProjectWork({
        agentId: currentAgentId,
        userText: originalUserText,
        historyMessages,
        summary: body.slice(0, 400),
        textToSend: body,
      });
    }
  } catch (err) {
    console.log('[project-workflow] sync turn failed:', err?.message || err);
  }
  // Auto-complete delegated tasks the coordinator has already reviewed.
  // Skip on error turns so a failed synthesis doesn't accidentally close work.
  if (turnStatus === 'ok' && reviewReadyDelegations.length > 0) {
    for (const item of reviewReadyDelegations) {
      try {
        completeDelegatedTask(item.delegatedTask, {
          replySummary: item.replySummary,
          note: `Auto-completed: coordinator (${currentAgentId}) synthesized the reply on turn end.`,
        });
      } catch (err) {
        console.log('[delegated-tasks] auto-complete failed:', err?.message || err);
      }
    }
  }
  onAgentTurnDone({ agentId: currentAgentId, status: turnStatus });
  return {
    textToSend: stripAsterisks(textToSend),
    voiceReplyText: voiceReplyText || undefined,
    imageReplyPath: imageReplyPath || undefined,
    imageReplyCaption: imageReplyCaption || undefined,
    skillsCalled,
    hadWriteOp,
  };
  } catch (err) {
    const errSummary = err?.message ? String(err.message) : String(err);
    logTeamActivity({
      type: 'turn_done',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      missionId: ctx?.missionId || '',
      status: 'error',
      message: `Turn aborted after ${Date.now() - turnStartedAt}ms: ${errSummary.slice(0, 160)}`,
    });
    onAgentTurnError({ agentId: currentAgentId, message: errSummary });
    throw err;
  }
}
