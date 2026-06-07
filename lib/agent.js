/**
 * Shared agent turn: tool loop (run_skill) + final reply resolution.
 * Used by both chat (index.js) and cron runner so the LLM can call the same skills in both.
 */

import { existsSync } from 'fs';
import { dirname } from 'path';
import { chat as llmChat, chatWithTools } from '../llm.js';
import { executeSkill } from '../skills/executor.js';
import { toUserMessage } from './user-error.js';
import { logTeamActivity } from './team-activity.js';
import { buildTurnStartInboxDetails, buildTurnDoneInboxDetails } from './team-inbox.js';
import { syncTurnToProjectWork } from './project-workflow.js';
import { onAgentTurnStart, onAgentSkillStart, onAgentSkillError, onAgentTurnDone } from './agent-context-state.js';
import { formatUserFacingReply } from './user-facing-reply.js';

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

const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_ROUNDS_WRITE = 10;
const MAX_TOOL_CALL_RETRIES = 3;
const MAX_COMPLETENESS_RETRIES = 2;

/** Tool names that constitute a write operation. */
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch_apply', 'go_write_run']);
const WRITE_SKILL_IDS = new Set(['write', 'edit', 'apply-patch', 'go-write']);

function isWriteToolCall(skillId, toolName) {
  if (WRITE_TOOL_NAMES.has(toolName)) return true;
  if (WRITE_SKILL_IDS.has(skillId)) return true;
  return false;
}

/** Extract parent directory from a file path arg for post-write verification. */
function extractWrittenDir(skillId, runArgs) {
  const pathArg = runArgs?.path || runArgs?.argv?.[0] || '';
  if (!pathArg || typeof pathArg !== 'string') return null;
  const d = skillId === 'write' || skillId === 'edit' ? dirname(pathArg) : pathArg;
  return d && d !== '.' ? d : null;
}

function unquote(s) {
  const t = String(s || '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function getToolNames(tools) {
  if (!Array.isArray(tools)) return new Set();
  return new Set(
    tools
      .map((t) => t?.function?.name)
      .filter(Boolean)
      .map((n) => String(n))
  );
}

function getRunSkillEnum(tools) {
  if (!Array.isArray(tools)) return [];
  const runSkill = tools.find((t) => t?.function?.name === 'run_skill');
  const maybeEnum = runSkill?.function?.parameters?.properties?.skill?.enum;
  return Array.isArray(maybeEnum) ? maybeEnum.map((s) => String(s)) : [];
}

function hasSkillEnabled(tools, skillId) {
  const names = getToolNames(tools);
  if (names.has('run_skill')) {
    const runSkillEnum = getRunSkillEnum(tools);
    if (runSkillEnum.includes(skillId)) return true;
  }
  const normalized = String(skillId || '').replace(/-/g, '_') + '_';
  for (const n of names) {
    if (String(n).startsWith(normalized)) return true;
  }
  return false;
}

function parseWriteIntent(userText) {
  const text = String(userText || '').trim();
  let m = text.match(/^write a file named\s+([^\s]+)\s+in the workspace with content:\s*([\s\S]+)$/i);
  if (m) return { path: unquote(m[1]), content: m[2] };
  m = text.match(/^create\s+([^\s]+)\s+in the workspace with exactly this content:\s*([\s\S]+)$/i);
  if (m) return { path: unquote(m[1]), content: m[2] };
  m = text.match(/^save to\s+([^\s]+)\s+the text:\s*([\s\S]+)$/i);
  if (m) return { path: unquote(m[1]), content: m[2] };
  return null;
}

function parseEditIntent(userText) {
  const text = String(userText || '').trim();
  let m = text.match(/^in\s+(?:the file\s+)?([^\s]+)\s+replace\s+(.+?)\s+with\s+(.+)$/i);
  if (m) return { path: unquote(m[1]), oldString: unquote(m[2]), newString: unquote(m[3]) };
  m = text.match(/^in\s+(?:the file\s+)?([^\s]+)\s+change\s+(.+?)\s+to\s+(.+)$/i);
  if (m) return { path: unquote(m[1]), oldString: unquote(m[2]), newString: unquote(m[3]) };
  m = text.match(/^edit\s+([^\s:]+)\s*:\s*replace\s+"([^"]+)"\s+with\s+"([^"]+)"$/i);
  if (m) return { path: unquote(m[1]), oldString: m[2], newString: m[3] };
  return null;
}

function parseHomeAssistantListIntent(userText) {
  const lower = String(userText || '').trim().toLowerCase();
  if (!lower) return null;
  // Only bypass the LLM for simple single-intent messages.
  // Multi-sentence or multi-question messages must go through the LLM.
  const sentenceCount = (lower.match(/[.!?]+/g) || []).length;
  const questionCount = (lower.match(/\?/g) || []).length;
  if (sentenceCount > 1 || questionCount > 1) return null;
  const wordCount = lower.split(/\s+/).length;
  if (wordCount > 12) return null;
  const listLike = /\blist\b|\bshow\b|\bwhat\b|\bwhich\b/.test(lower);
  if (!listLike) return null;
  if (/\blight(s)?\b/.test(lower)) return { command: 'list lights' };
  if (/\bautomation(s)?\b/.test(lower)) return { command: 'list automation' };
  if (/\bswitch(es)?\b/.test(lower)) return { command: 'list switch' };
  if (/\bdevices?\b|\bentities?\b/.test(lower)) return { command: 'list' };
  return null;
}

function extractToolErrorMessage(result) {
  if (!result || typeof result !== 'string') return '';
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed.error === 'string') return parsed.error.trim();
  } catch (_) {}
  return '';
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
}) {
  const turnStartedAt = Date.now();
  const currentAgentId = ctx?.agentId || 'main';
  const userPreview = summarizeText(userText, 100);
  logTeamActivity({
    type: 'turn_start',
    agentId: currentAgentId,
    depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
    jid: ctx?.jid || '',
    message: userPreview || 'New request',
    details: buildTurnStartInboxDetails({ userText, ctx }),
  });
  onAgentTurnStart({ agentId: currentAgentId, userText, ctx });
  const llmOptions = ctx?.agentId ? { agentId: ctx.agentId } : {};
  const useTools = Array.isArray(tools) && tools.length > 0;
  const toolsToUse = useTools ? tools : [];
  const emitStep = typeof onToolProgress === 'function' ? onToolProgress : null;
  const forcedWrite = hasSkillEnabled(toolsToUse, 'write') ? parseWriteIntent(userText) : null;
  if (forcedWrite) {
    const pl = fileToolProgressLine('write', forcedWrite, null);
    if (emitStep && pl) emitStep(pl);
    const result = await executeSkill('write', ctx, forcedWrite);
    let body = 'Done.';
    try {
      const parsed = JSON.parse(result);
      if (parsed?.error) body = toUserMessage(parsed.error);
      else body = `Wrote ${parsed.path || forcedWrite.path} with the exact content you provided.`;
    } catch (_) {}
    logTeamActivity({
      type: 'turn_done',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      status: 'ok',
      message: `Handled in ${Date.now() - turnStartedAt}ms (write).`,
    });
    return { textToSend: stripAsterisks('[Pasture] ' + body), skillsCalled: ['write'] };
  }
  const forcedEdit = hasSkillEnabled(toolsToUse, 'edit') ? parseEditIntent(userText) : null;
  if (forcedEdit) {
    const pl = fileToolProgressLine('edit', forcedEdit, null);
    if (emitStep && pl) emitStep(pl);
    const result = await executeSkill('edit', ctx, forcedEdit);
    let body = 'Done.';
    try {
      const parsed = JSON.parse(result);
      if (parsed?.error) body = toUserMessage(parsed.error);
      else body = `Replaced "${forcedEdit.oldString}" with "${forcedEdit.newString}" in ${parsed.path || forcedEdit.path}.`;
    } catch (_) {}
    logTeamActivity({
      type: 'turn_done',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      status: 'ok',
      message: `Handled in ${Date.now() - turnStartedAt}ms (edit).`,
    });
    return { textToSend: stripAsterisks('[Pasture] ' + body), skillsCalled: ['edit'] };
  }
  const forcedHa = hasSkillEnabled(toolsToUse, 'home-assistant') ? parseHomeAssistantListIntent(userText) : null;
  if (forcedHa) {
    const result = await executeSkill('home-assistant', ctx, { command: forcedHa.command });
    let body = result || '';
    try {
      const parsed = JSON.parse(result || '{}');
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.error === 'string') body = toUserMessage(parsed.error);
        else if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
          body = parsed.summary.trim();
        } else if (Array.isArray(parsed.summaries) && parsed.summaries.length) {
          body = parsed.summaries.slice(0, 30).join('\n');
        } else if (Array.isArray(parsed.items) || Array.isArray(parsed.entities)) {
          const rows = Array.isArray(parsed.items) ? parsed.items : parsed.entities;
          const names = rows
            .map((x) => x?.attributes?.friendly_name || x?.name || x?.id)
            .filter(Boolean)
            .slice(0, 30);
          const total = Number(parsed.total);
          const queryLabel = forcedHa.command === 'list lights'
            ? 'lights'
            : (forcedHa.command === 'list' ? 'entities/devices' : 'entities');
          if (names.length === 0) {
            body = `Home Assistant query succeeded: no ${queryLabel} found.`;
          } else if (Number.isFinite(total) && total > names.length) {
            body = `Home Assistant returned ${total} ${queryLabel}. Showing first ${names.length}:\n` + names.join('\n');
          } else {
            body = `Home Assistant returned ${names.length} ${queryLabel}:\n` + names.join('\n');
          }
        } else if (typeof parsed.message === 'string' && parsed.message.trim()) {
          body = `Home Assistant query succeeded: ${parsed.message.trim()}`;
        }
      }
    } catch (_) {}
    const safeBody = String(body || '').trim() || 'No entities found.';
    logTeamActivity({
      type: 'turn_done',
      agentId: currentAgentId,
      depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
      jid: ctx?.jid || '',
      status: 'ok',
      message: `Handled in ${Date.now() - turnStartedAt}ms (home-assistant).`,
    });
    return { textToSend: stripAsterisks('[Pasture] ' + safeBody), skillsCalled: ['home-assistant'] };
  }
  let messages = [
    { role: 'system', content: systemPrompt },
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
  let voiceReplyText = null;
  let lastRoundHadToolError = false;
  const skillsCalled = [];
  let hadWriteOp = false;
  const writtenDirs = new Set();

  for (let round = 0; round <= (hadWriteOp ? MAX_TOOL_ROUNDS_WRITE : MAX_TOOL_ROUNDS); round++) {
    if (!useTools) {
      const rawReply = await llmChat(messages, llmOptions);
      finalContent = stripThinking(rawReply);
      break;
    }
    let content;
    let toolCalls;
    let toolCallRetries = 0;
    while (toolCallRetries <= MAX_TOOL_CALL_RETRIES) {
      const response = await chatWithTools(messages, toolsToUse, llmOptions);
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
      if (toolCallRetries >= MAX_TOOL_CALL_RETRIES) break;
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
        runArgs.action = resolved.action;
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
      const isToolError = typeof result === 'string' && result.trim().startsWith('{"error":');
      const toolMessage = isToolError
        ? extractToolErrorMessage(result) || `Skill ${skillId} failed`
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
      if (isToolError) {
        onAgentSkillError({
          agentId: currentAgentId,
          skillId,
          message: extractToolErrorMessage(result) || toolMessage,
        });
      }
      if (isToolError) lastRoundHadToolError = true;
      // Track write operations for extended round limit and post-loop verification
      if (!isToolError && isWriteToolCall(skillId, tc.name)) {
        hadWriteOp = true;
        const d = extractWrittenDir(skillId, runArgs);
        if (d) writtenDirs.add(d);
      }
      if (skillId === 'cron' && action === 'list' && result && typeof result === 'string' && !isToolError) {
        cronListResult = result;
      }
      if (skillId === 'search' && result && typeof result === 'string') {
        const newHasHeadlines = result.includes('Top news / headlines');
        const newIsError = result.trim().startsWith('{"error":') || result.includes('The search engine returned an error');
        const currentIsError = !searchResult || searchResult.trim().startsWith('{"error":') || searchResult.includes('The search engine returned an error');
        if (!searchResult || newHasHeadlines || (currentIsError && !newIsError)) searchResult = result;
      }
      if (skillId === 'browse' && result && typeof result === 'string' && !result.trim().startsWith('{"error":')) {
        browseResult = result;
      }
      if (skillId === 'vision' && result && typeof result === 'string' && !result.trim().startsWith('{"error":')) {
        visionResult = result;
        try {
          const parsed = JSON.parse(result);
          if (parsed?.imageReply?.path) {
            imageReplyPath = parsed.imageReply.path;
            imageReplyCaption = (parsed.imageReply.caption && String(parsed.imageReply.caption).trim()) || parsed.message || '';
          }
        } catch (_) {}
      }
      if (skillId === 'agent-send' && result && typeof result === 'string') {
        if (result.trim().startsWith('{"error":')) lastRoundHadToolError = true;
        else {
          try {
            const parsed = JSON.parse(result);
            if (parsed?.reply) agentSendResult = parsed;
          } catch (_) {}
        }
      }
      if (!isToolError && result && typeof result === 'string' && result.trim() && !result.trim().startsWith('{"error":')) {
        lastToolResult = result;
      }
      if (skillId === 'speech' && action === 'reply_as_voice' && !isToolError && runArgs.text && typeof runArgs.text === 'string') {
        voiceReplyText = String(runArgs.text).trim();
      }
      let toolContent = result;
      if (typeof getFullSkillDoc === 'function') {
        const fullDoc = getFullSkillDoc(skillId);
        if (fullDoc) toolContent = result + '\n\n---\nFull skill doc for ' + skillId + ':\n' + fullDoc;
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
    }
  }

  // Post-write verification: run `ls` on written directories so the LLM reports what actually exists
  if (hadWriteOp && writtenDirs.size > 0) {
    try {
      const verifyParts = [];
      for (const dir of writtenDirs) {
        try {
          const lsResult = await executeSkill('go-read', ctx, { command: 'ls', argv: ['-la', dir] });
          if (lsResult && !lsResult.trim().startsWith('{"error":')) {
            verifyParts.push(`Directory ${dir}:\n${lsResult.trim()}`);
          }
        } catch (_) {}
      }
      if (verifyParts.length > 0) {
        messages.push({
          role: 'user',
          content: `Verification (actual files on disk after write operations):\n${verifyParts.join('\n\n')}\n\nReport only what was actually written based on the above. If anything is missing, say so.`,
        });
      }
    } catch (_) {}
  }

  if (useTools && !stripThinking(finalContent).trim() && lastRoundHadToolError) {
    try {
      const { content: clarification } = await chatWithTools(messages, [], llmOptions);
      const text = clarification && stripThinking(clarification).trim();
      if (text) finalContent = text;
    } catch (_) {}
  }
  if (searchResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(messages, [], llmOptions);
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  if (browseResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(messages, [], llmOptions);
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  if (visionResult && !stripThinking(finalContent).trim()) {
    try {
      const synthesized = await chatWithTools(messages, [], llmOptions);
      const reply = synthesized?.content && stripThinking(synthesized.content).trim();
      if (reply) finalContent = reply;
    } catch (_) {}
  }
  const looksLikeBrushOff = (s) => /^(Done\.?|Anything else\?|Done\.\s*Anything else\?)\s*$/i.test((s || '').trim());
  if (lastToolResult && (!stripThinking(finalContent).trim() || looksLikeBrushOff(finalContent))) {
    try {
      const { content: synthesized } = await chatWithTools(messages, [], llmOptions);
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
        ], llmOptions);
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
        content: `You didn't answer all parts of the question. Missing: "${probeMissing}". Use your tools to answer ALL of them now in one response. Do NOT call project-workflow apply_plan or apply_setup unless the user's message explicitly approved creation (yes / go ahead / create it).`,
      });

      // Execute one tool round for the missing parts. The LLM can fire multiple parallel
      // tool calls here (one per missing item), so a single retry round covers all gaps.
      // Replace finalContent rather than appending to avoid duplicate answer blocks.
      try {
        const retryResp = await chatWithTools(messages, toolsToUse, llmOptions);
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
              tcRunArgs = { ...tcPayload, action: tcResolved.action };
            } else {
              tcSkillId = tcPayload.skill && String(tcPayload.skill).trim();
              tcRunArgs = tcPayload.arguments && typeof tcPayload.arguments === 'object' ? { ...tcPayload.arguments } : {};
              if (tcPayload.command) tcRunArgs.action = String(tcPayload.command).trim();
            }
            if (!tcSkillId) {
              messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'missing skill' }) });
              continue;
            }
            const tcResult = await executeSkill(tcSkillId, ctx, tcRunArgs);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: tcResult });
          }
          const synthesis = await chatWithTools(messages, [], llmOptions);
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

  const trimmedFinal = stripThinking(finalContent).trim();
  const looksLikeToolCallJson = /"skill"\s*:|\"run_skill\"|"action"\s*:\s*"search"|"parameters"\s*:\s*\{/.test(trimmedFinal);
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
  if (useAgentSendAsReply) {
    textToSend = withPrefix(formatUserFacingReply(agentReplyText));
  } else if (useSearchResultAsReply) {
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
  } else if (trimmedFinal) {
    textToSend = withPrefix(trimmedFinal);
  } else if (cronListResult && cronListResult.trim()) {
    textToSend = withPrefix(cronListResult.trim());
  } else if (searchResult && searchResult.trim()) {
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
  } else if (lastToolResult && lastToolResult.trim() && !lastToolResult.trim().startsWith('{"error":')) {
    let reply = lastToolResult.trim();
    try {
      const parsed = JSON.parse(reply);
      if (parsed && typeof parsed.error === 'string') reply = toUserMessage(parsed.error);
    } catch (_) {}
    reply = reply.slice(0, 2000) + (reply.length > 2000 ? '…' : '');
    textToSend = withPrefix(reply);
  } else {
    textToSend = '[Pasture] Done. Anything else?';
  }
  const body = textToSend.replace(/^\[Pasture\]\s*/i, '').trim();
  if (body.startsWith('{"error":')) {
    textToSend = '[Pasture] I need a bit more detail—when should I remind you, and what message would you like?';
  }
  logTeamActivity({
    type: 'turn_done',
    agentId: currentAgentId,
    depth: Number.isFinite(ctx?.agentDepth) ? ctx.agentDepth : 0,
    jid: ctx?.jid || '',
    status: 'ok',
    message: `Handled in ${Date.now() - turnStartedAt}ms using ${skillsCalled.length} skill${skillsCalled.length === 1 ? '' : 's'}.`,
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
  onAgentTurnDone({ agentId: currentAgentId });
  return {
    textToSend: stripAsterisks(textToSend),
    voiceReplyText: voiceReplyText || undefined,
    imageReplyPath: imageReplyPath || undefined,
    imageReplyCaption: imageReplyCaption || undefined,
    skillsCalled,
  };
}

