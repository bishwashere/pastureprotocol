/** Agent-facing checkpoint/read operations for the current run's worklog. */

import {
  appendTaskWorklogCheckpoint,
  formatTaskWorklogPromptBlock,
  readTaskWorklog,
} from '../../context/task-worklog.js';

function result(value) {
  return JSON.stringify(value, null, 2);
}

function actionFrom(toolName, args) {
  const fromTool = String(toolName || '').replace(/^worklog_/, '').trim();
  return fromTool || String(args?.action || args?.command || '').trim();
}

/**
 * Identity is deliberately taken only from ctx.taskWorklogId. No argument is
 * accepted as a worklog/task/run id, preventing cross-run reads or writes.
 */
export async function executeWorklog(ctx, args = {}, toolName) {
  if (!ctx?.taskWorklogId) {
    return result({ error: 'No task worklog is active for this run.' });
  }

  const action = actionFrom(toolName, args);
  if (action === 'checkpoint') {
    const summary = String(args?.summary ?? '').trim();
    if (!summary) return result({ error: 'summary is required for a checkpoint.' });
    const worklog = appendTaskWorklogCheckpoint(ctx, {
      label: args?.label,
      summary,
      nextStep: args?.nextStep,
    });
    if (!worklog) return result({ error: 'The active task worklog id is invalid.' });
    const checkpoint = worklog.checkpoints[worklog.checkpoints.length - 1] || null;
    return result({
      ok: true,
      status: worklog.status,
      checkpoint,
      checkpointCount: worklog.counts.checkpoints,
    });
  }

  if (action === 'read') {
    const worklog = readTaskWorklog(ctx);
    if (!worklog) return result({ error: 'No task worklog exists for this run.' });
    return result({
      ok: true,
      status: worklog.status,
      checkpointCount: worklog.counts.checkpoints,
      toolEventCount: worklog.counts.toolEvents,
      promptBlock: formatTaskWorklogPromptBlock(worklog),
    });
  }

  return result({ error: `Unknown worklog action: ${action || '(none)'}. Use checkpoint or read.` });
}
