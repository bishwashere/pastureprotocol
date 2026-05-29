/**
 * background-tasks executor: spawn, list, cancel detached chat work.
 */

import {
  spawnBackgroundTask,
  listTasksForJid,
  formatTasksList,
  cancelBackgroundTask,
} from '../background-tasks.js';

function err(message) {
  return JSON.stringify({ error: message });
}

/**
 * @param {object} ctx - Must include jid, sock, spawnBackgroundTask or full chat ctx.
 * @param {object} args
 * @param {string} [toolName] - background_tasks_spawn | list | cancel
 */
export async function executeBackgroundTasks(ctx, args = {}, toolName) {
  const action = (toolName || '').replace(/^background_tasks_/, '') || (args?.action && String(args.action).trim());

  if (action === 'list') {
    const jid = ctx?.jid;
    if (!jid) return err('No chat context for list.');
    return formatTasksList(jid);
  }

  if (action === 'cancel') {
    const taskId = String(args.taskId ?? args.id ?? '').trim();
    if (!taskId) return err('taskId is required for cancel.');
    const result = cancelBackgroundTask(ctx.jid, taskId);
    if (!result.ok) return err(result.error);
    return JSON.stringify({ cancelled: true, taskId: result.taskId, shortId: String(result.taskId).slice(0, 8) });
  }

  if (action === 'spawn') {
    const prompt = String(args.prompt ?? args.message ?? args.task ?? '').trim();
    const label = args.label != null ? String(args.label).trim() : undefined;
    const spawner = typeof ctx?.spawnBackgroundTask === 'function'
      ? (opts) => ctx.spawnBackgroundTask(opts)
      : (opts) => spawnBackgroundTask({ ...opts, ctx });
    const result = spawner({ prompt, label });
    if (!result.ok) return err(result.error);
    return JSON.stringify({
      taskId: result.taskId,
      shortId: result.shortId,
      status: 'running',
      message: `Background task ${result.shortId} started. I'll announce the result here when done. Check /tasks for status.`,
    });
  }

  return err(`Unknown action: ${action || '(none)'}. Use spawn, list, or cancel.`);
}
