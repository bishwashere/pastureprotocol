/**
 * Chat background tasks — OpenClaw-style sub-agent work for long-running chat jobs.
 *
 * Spawn returns a task id immediately; the agent turn runs detached and announces
 * back to the same chat when done. Tasks are persisted per jid in tasks.json.
 */

import { readFileSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { getBackgroundTasksStorePath, getCronStorePath } from '../util/paths.js';
import { writeJsonAtomic } from '../util/atomic-write.js';
import { runAgentTurn } from './agent.js';
import { getSkillContext, getEnabledSkillIds, getEnabledSkillSummaries } from '../../skills/loader.js';
import { routeTurn, turnRouteToSystemBlock } from './turn-router.js';
import { buildOneOnOneSystemPrompt } from './system-prompt.js';
import { ensureChatSession } from '../context/chat-session.js';
import { runInternalAgentTurn } from './internal-agent-turn.js';
import { isTelegramChatId } from '../channels/telegram.js';
import { readLastPrivateExchanges, DEFAULT_CHAT_HISTORY_EXCHANGES } from '../context/chat-log.js';
import { toUserMessage } from '../util/user-error.js';
import { isDailyLimitReached, isDailyLimitError } from '../../llm.js';
import { buildAgentTeamPromptBlock } from './agent-config.js';
import { buildMissionsContextBlock } from '../context/missions-context.js';
import { buildProjectsContextBlock } from '../context/projects-context.js';
import { buildProjectWorkflowContextBlock } from '../context/project-workflow.js';
import { buildRetrospectiveContextBlock } from './retrospective.js';
import { getMemoryConfig } from '../context/memory-config.js';
import { isNonTaskMessage } from './evaluate-team-capability.js';

const MAX_RUNNING_PER_JID = 3;
const MAX_TASKS_PER_JID = 30;
const MAX_HISTORY_EXCHANGES = DEFAULT_CHAT_HISTORY_EXCHANGES;
const SHORT_ID_LEN = 8;

/** @type {Map<string, Promise<void>>} */
const inFlight = new Map();
/**
 * AbortController per running task, indexed by task id. Audit finding #14:
 * `cancelBackgroundTask` previously only flipped the JSON status — the
 * already-running runAgentTurn kept consuming LLM quota and tool resources.
 * Aborting the controller now causes the in-flight turn to exit cooperatively
 * at the next round boundary.
 *
 * @type {Map<string, AbortController>}
 */
const abortControllers = new Map();

/** Injectable runner for unit tests. */
let runTurnImpl = runBackgroundAgentTurn;

export function _setBackgroundRunTurnForTests(fn) {
  runTurnImpl = typeof fn === 'function' ? fn : runBackgroundAgentTurn;
}

function shortId(id) {
  return String(id || '').slice(0, SHORT_ID_LEN);
}

function loadAllTasks(storePath = getBackgroundTasksStorePath()) {
  try {
    if (!existsSync(storePath)) return [];
    const raw = readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

function saveAllTasks(tasks, storePath = getBackgroundTasksStorePath()) {
  writeJsonAtomic(storePath, { tasks });
}

function findTask(tasks, taskId) {
  const id = String(taskId || '').trim();
  if (!id) return null;
  return tasks.find((t) => t.id === id || t.id.startsWith(id)) || null;
}

function pruneTasksForJid(tasks, jid) {
  const mine = tasks.filter((t) => t.jid === jid);
  const rest = tasks.filter((t) => t.jid !== jid);
  const terminal = mine.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled');
  const active = mine.filter((t) => t.status === 'running');
  terminal.sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
  const keepTerminal = terminal.slice(0, Math.max(0, MAX_TASKS_PER_JID - active.length));
  return rest.concat(active, keepTerminal);
}

function updateTask(taskId, patch, storePath = getBackgroundTasksStorePath()) {
  const tasks = loadAllTasks(storePath);
  const task = findTask(tasks, taskId);
  if (!task) return null;
  Object.assign(task, patch, { updatedAtMs: Date.now() });
  saveAllTasks(tasks, storePath);
  return task;
}

/**
 * Mark stale running tasks failed after daemon restart.
 */
export function recoverStaleBackgroundTasks(storePath = getBackgroundTasksStorePath()) {
  const tasks = loadAllTasks(storePath);
  let changed = false;
  for (const task of tasks) {
    if (task.status === 'running') {
      task.status = 'failed';
      task.error = 'Interrupted by daemon restart';
      task.finishedAtMs = Date.now();
      task.updatedAtMs = Date.now();
      changed = true;
    }
  }
  if (changed) saveAllTasks(tasks, storePath);
}

export function listTasksForJid(jid, storePath = getBackgroundTasksStorePath()) {
  const key = String(jid || '').trim();
  return loadAllTasks(storePath)
    .filter((t) => t.jid === key)
    .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
}

function formatRelative(ms) {
  if (!ms) return '';
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function formatTasksList(jid, storePath = getBackgroundTasksStorePath()) {
  const tasks = listTasksForJid(jid, storePath);
  if (tasks.length === 0) {
    return 'No background tasks for this chat. Ask me to run something in the background, or use the background_tasks_spawn tool.';
  }
  const lines = tasks.map((t, i) => {
    const label = (t.label || t.prompt || '').slice(0, 50) + ((t.label || t.prompt || '').length > 50 ? '…' : '');
    const when = t.status === 'running'
      ? `started ${formatRelative(t.startedAtMs || t.createdAtMs)}`
      : t.status === 'done'
        ? `done ${formatRelative(t.finishedAtMs)}`
        : t.status === 'failed'
          ? `failed ${formatRelative(t.finishedAtMs)}`
          : `cancelled ${formatRelative(t.finishedAtMs)}`;
    const err = t.status === 'failed' && t.error ? ` — ${String(t.error).slice(0, 60)}` : '';
    return `${i + 1}. ${shortId(t.id)} — ${t.status} — "${label}" (${when})${err}`;
  });
  return `Background tasks (${tasks.length}):\n${lines.join('\n')}\n\nUse /tasks anytime. Cancel with background_tasks_cancel and the task id.`;
}

export function cancelBackgroundTask(jid, taskId, storePath = getBackgroundTasksStorePath()) {
  const tasks = loadAllTasks(storePath);
  const task = findTask(tasks.filter((t) => t.jid === jid), taskId);
  if (!task) return { ok: false, error: `Task ${taskId} not found for this chat.` };
  if (task.status !== 'running') {
    return { ok: false, error: `Task ${shortId(task.id)} is already ${task.status}.` };
  }
  updateTask(task.id, { status: 'cancelled', finishedAtMs: Date.now() }, storePath);
  // Audit finding #14: signal the in-flight turn to exit at the next round
  // boundary instead of letting it run to completion.
  const controller = abortControllers.get(task.id);
  if (controller && !controller.signal.aborted) {
    try {
      controller.abort();
    } catch (_) {}
  }
  return { ok: true, taskId: task.id };
}

function sanitizeOutbound(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\s*—\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildAnnouncement(task, textToSend) {
  const sid = shortId(task.id);
  const labelLine = task.label ? `${task.label}\n\n` : '';
  const body = sanitizeOutbound(textToSend);
  const telegram = isTelegramChatId(task.jid);
  const prefix = task.status === 'done'
    ? (telegram ? `✅ Background task ${sid} done\n\n` : `✅ Background task ${sid} done\n\n`)
    : (telegram ? `❌ Background task ${sid} failed\n\n` : `❌ Background task ${sid} failed\n\n`);
  if (task.status === 'failed') {
    return `${prefix}${task.error || 'Unknown error'}`;
  }
  return `${prefix}${labelLine}${body}`.trim();
}

async function announceTaskResult(task, textToSend, sock, onExchange) {
  const msg = buildAnnouncement(task, textToSend);
  if (!msg || !sock || typeof sock.sendMessage !== 'function') return;
  try {
    await sock.sendMessage(task.jid, { text: msg });
  } catch (err) {
    console.error('[background-tasks] announce failed:', err.message);
  }
  if (typeof onExchange === 'function') {
    try {
      onExchange({ user: `[background ${shortId(task.id)}]`, assistant: msg, timestampMs: Date.now(), jid: task.jid });
    } catch (_) {}
  }
}

/**
 * Run one detached agent turn for a background task.
 */
async function runBackgroundAgentTurn(task, parentCtx) {
  const prompt = String(task.prompt || '').trim();
  const agentId = task.agentId || parentCtx?.agentId || 'main';
  const isGroup = !!parentCtx?.isGroup;
  const groupJid = isGroup ? parentCtx?.jid : undefined;
  const sessionKey = `bg:${task.id}`;
  const { sessionId } = ensureChatSession(sessionKey, { userText: prompt });

  const ctx = {
    storePath: parentCtx?.storePath || getCronStorePath(),
    jid: parentCtx?.jid || task.jid,
    workspaceDir: parentCtx?.workspaceDir,
    agentId,
    scheduleOneShot: parentCtx?.scheduleOneShot || (() => {}),
    startCron: parentCtx?.startCron || (() => {}),
    groupNonOwner: !!parentCtx?.groupNonOwner,
    isGroup,
    isBackgroundTask: true,
    runInternalAgent: isGroup ? undefined : runInternalAgentTurn,
    agentDepth: 0,
    agentCallChain: [agentId],
  };
  const abortSignal = parentCtx?.abortSignal || null;

  const enabledSkillIds = getEnabledSkillIds({ groupJid, agentId });
  const enabledSkillSummaries = getEnabledSkillSummaries({ groupJid, agentId });
  const turnRoute = enabledSkillIds.length > 0
    ? await routeTurn({ userText: prompt, availableSkillIds: enabledSkillIds, availableSkillSummaries: enabledSkillSummaries, agentId })
    : null;

  const plannerSaysNoTools = turnRoute !== null && Array.isArray(turnRoute.skills) && turnRoute.skills.length === 0;
  let skillContext = null;
  let toolsToUse = [];
  if (!plannerSaysNoTools) {
    skillContext = getSkillContext({ groupJid, agentId, hintSkills: turnRoute?.skills ?? null });
    toolsToUse = Array.isArray(skillContext?.runSkillTool) && skillContext.runSkillTool.length > 0
      ? skillContext.runSkillTool
      : [];
  }

  // Audit finding #24: background-task turns previously had a much thinner
  // prompt than chat / internal-agent-turn. Add the same context blocks so
  // background work has the same world model: team roster, missions,
  // projects/workflow, retrospective lessons. (Session bootstrap and pair
  // history are skipped — there is no parent channel exchange to replay.)
  const baseSystemPrompt = buildOneOnOneSystemPrompt(ctx.workspaceDir) + buildAgentTeamPromptBlock(agentId);
  const planBlock = turnRouteToSystemBlock(turnRoute);
  let systemPrompt = planBlock ? baseSystemPrompt + '\n\n' + planBlock : baseSystemPrompt;
  if (!isNonTaskMessage(prompt)) {
    try {
      const memoryConfig = getMemoryConfig();
      const retroBlock = await buildRetrospectiveContextBlock(prompt, memoryConfig);
      if (retroBlock) systemPrompt += retroBlock;
    } catch (_) {}
    try {
      const missionsBlock = buildMissionsContextBlock({ userText: prompt, historyMessages: [], agentId });
      if (missionsBlock) systemPrompt += missionsBlock;
    } catch (_) {}
    try {
      const projectsBlock = buildProjectsContextBlock({ userText: prompt, historyMessages: [] });
      if (projectsBlock) systemPrompt += projectsBlock;
    } catch (_) {}
    try {
      const workflowBlock = buildProjectWorkflowContextBlock({ userText: prompt, historyMessages: [], agentId });
      if (workflowBlock) systemPrompt += workflowBlock;
    } catch (_) {}
  }
  const historyMessages = readLastPrivateExchanges(ctx.workspaceDir, sessionKey, MAX_HISTORY_EXCHANGES, sessionId);

  const turn = await runAgentTurn({
    userText: prompt,
    ctx,
    systemPrompt,
    tools: toolsToUse,
    historyMessages,
    getFullSkillDoc: skillContext?.getFullSkillDoc ?? (() => ''),
    resolveToolName: skillContext?.resolveToolName ?? (() => null),
    abortSignal,
  });

  return {
    textToSend: sanitizeOutbound(turn?.textToSend || ''),
    skillsCalled: Array.isArray(turn?.skillsCalled) ? turn.skillsCalled : [],
  };
}

async function executeBackgroundTask(taskId, parentCtx) {
  const storePath = getBackgroundTasksStorePath();
  const tasks = loadAllTasks(storePath);
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.status !== 'running') return;

  updateTask(taskId, { startedAtMs: Date.now() }, storePath);

  try {
    const { textToSend, skillsCalled } = await runTurnImpl(task, parentCtx);
    const latest = findTask(loadAllTasks(storePath), taskId);
    if (!latest || latest.status === 'cancelled') {
      console.log('[background-tasks] task cancelled, skipping announce:', shortId(taskId));
      return;
    }
    updateTask(taskId, {
      status: 'done',
      result: textToSend,
      skillsCalled,
      finishedAtMs: Date.now(),
    }, storePath);
    await announceTaskResult(
      { ...task, status: 'done' },
      textToSend,
      parentCtx?.sock,
      parentCtx?.onExchange,
    );
    console.log('[background-tasks] done:', shortId(taskId), 'skills:', (skillsCalled || []).join(',') || 'none');
  } catch (err) {
    const msg = toUserMessage(err);
    updateTask(taskId, {
      status: 'failed',
      error: msg,
      finishedAtMs: Date.now(),
    }, storePath);
    if (!isDailyLimitError(err)) {
      await announceTaskResult(
        { ...task, status: 'failed', error: msg },
        '',
        parentCtx?.sock,
        parentCtx?.onExchange,
      );
    }
    console.error('[background-tasks] failed:', shortId(taskId), isDailyLimitError(err) ? 'daily limit reached' : msg);
  } finally {
    inFlight.delete(taskId);
  }
}

/**
 * Spawn a background task. Returns immediately with task id; work runs async.
 *
 * @param {object} opts
 * @param {string} opts.prompt - Task for the background agent.
 * @param {string} [opts.label] - Short label for /tasks listing.
 * @param {object} opts.ctx - Parent agent ctx (jid, agentId, sock, etc.).
 * @returns {{ ok: boolean, taskId?: string, error?: string }}
 */
export function spawnBackgroundTask({ prompt, label, ctx }) {
  const message = String(prompt || '').trim();
  if (!message) return { ok: false, error: 'prompt/message is required.' };
  if (ctx?.isBackgroundTask) {
    return { ok: false, error: 'Cannot spawn nested background tasks.' };
  }
  if (isDailyLimitReached()) {
    return { ok: false, error: "Daily AI call limit reached. Background tasks will resume at midnight UTC." };
  }
  const jid = String(ctx?.jid || '').trim();
  if (!jid) return { ok: false, error: 'No chat jid in context.' };
  if (!ctx?.sock || typeof ctx.sock.sendMessage !== 'function') {
    return { ok: false, error: 'Background tasks are not available in this context.' };
  }

  const storePath = getBackgroundTasksStorePath();
  const running = listTasksForJid(jid, storePath).filter((t) => t.status === 'running');
  if (running.length >= MAX_RUNNING_PER_JID) {
    return {
      ok: false,
      error: `Too many running background tasks (${MAX_RUNNING_PER_JID} max). Check /tasks or wait for one to finish.`,
    };
  }

  const taskId = randomUUID();
  const now = Date.now();
  const task = {
    id: taskId,
    jid,
    agentId: ctx.agentId || 'main',
    prompt: message,
    label: String(label || message).slice(0, 120).trim(),
    status: 'running',
    createdAtMs: now,
    updatedAtMs: now,
  };

  let tasks = loadAllTasks(storePath);
  tasks.push(task);
  tasks = pruneTasksForJid(tasks, jid);
  saveAllTasks(tasks, storePath);

  // Create an AbortController so cancelBackgroundTask can interrupt the
  // in-flight runAgentTurn between rounds (audit finding #14).
  const controller = new AbortController();
  abortControllers.set(taskId, controller);

  const parentCtx = {
    ...ctx,
    spawnBackgroundTask: undefined,
    abortSignal: controller.signal,
  };

  const promise = executeBackgroundTask(taskId, parentCtx);
  inFlight.set(taskId, promise);
  promise
    .catch((e) => console.error('[background-tasks] unhandled:', e.message))
    .finally(() => {
      inFlight.delete(taskId);
      abortControllers.delete(taskId);
    });

  return { ok: true, taskId, shortId: shortId(taskId), status: 'running' };
}
