import { processDueGoalsInStore, runGoalTick } from './goals.js';

let timer = null;
let running = false;

function clampLoopMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30_000;
  return Math.max(30_000, Math.min(300_000, Math.floor(n)));
}

export function stopGoalEngine() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function startGoalEngine(opts = {}) {
  if (timer) return;
  const loopMs = clampLoopMs(opts.loopMs);
  const runGoalTurn = typeof opts.runGoalTurn === 'function' ? opts.runGoalTurn : null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!runGoalTurn) throw new Error('startGoalEngine requires runGoalTurn');

  async function cycle() {
    if (running) return;
    running = true;
    try {
      const due = processDueGoalsInStore({ maxPerCycle: 4 });
      for (const goal of due) {
        try {
          onLog({ type: 'goal_tick_start', goalId: goal.id, ownerAgentId: goal.ownerAgentId, title: goal.title });
          const result = await runGoalTick(goal.id, { runGoalTurn });
          onLog({
            type: result?.error ? 'goal_tick_error' : 'goal_tick_done',
            goalId: goal.id,
            ownerAgentId: goal.ownerAgentId,
            title: goal.title,
            status: result?.goal?.status || '',
            message: result?.goal?.lastActivity || '',
          });
          if (Array.isArray(result?.createdSubgoals) && result.createdSubgoals.length) {
            for (const child of result.createdSubgoals) {
              onLog({
                type: 'goal_subgoal_created',
                goalId: goal.id,
                ownerAgentId: child.ownerAgentId,
                title: child.title,
                message: `Subgoal created: ${child.title}`,
              });
            }
          }
        } catch (err) {
          onLog({
            type: 'goal_tick_error',
            goalId: goal.id,
            ownerAgentId: goal.ownerAgentId,
            title: goal.title,
            message: err?.message || String(err),
          });
        }
      }
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => {
    cycle().catch(() => {});
  }, loopMs);
  setTimeout(() => {
    cycle().catch(() => {});
  }, 2_000);
}
