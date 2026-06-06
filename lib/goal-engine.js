import { processDueGoalsInStore, runGoalTick } from './goals.js';
import { analyzeTeamActivityForInitiatives } from './initiatives.js';
import { runCuriosityMomentumCycle } from './curiosity-momentum.js';

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
      try {
        const analysis = analyzeTeamActivityForInitiatives({ minIntervalMs: 3 * 60 * 60_000 });
        if (analysis && !analysis.skipped && ((analysis.created && analysis.created.length) || (analysis.merged && analysis.merged.length))) {
          onLog({
            type: 'initiative_scan_done',
            message: `Initiative scan created=${analysis.created?.length || 0} merged=${analysis.merged?.length || 0}`,
          });
        }
      } catch (_) {}
      const tickedGoalIds = [];
      const due = processDueGoalsInStore({ maxPerCycle: 4 });
      for (const goal of due) {
        try {
          onLog({ type: 'goal_tick_start', goalId: goal.id, ownerAgentId: goal.ownerAgentId, title: goal.title });
          const result = await runGoalTick(goal.id, { runGoalTurn });
          tickedGoalIds.push(goal.id);
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
                subgoalId: child.id || '',
                ownerAgentId: child.ownerAgentId || child.assignee || goal.ownerAgentId,
                title: child.title,
                message: `Subgoal created: ${child.title}`,
              });
            }
          }
        } catch (err) {
          tickedGoalIds.push(goal.id);
          onLog({
            type: 'goal_tick_error',
            goalId: goal.id,
            ownerAgentId: goal.ownerAgentId,
            title: goal.title,
            message: err?.message || String(err),
          });
        }
      }
      try {
        const curiosity = await runCuriosityMomentumCycle({
          runGoalTurn,
          excludeGoalIds: tickedGoalIds,
        });
        if (curiosity?.results?.length) {
          for (const row of curiosity.results) {
            if (row.error) {
              onLog({
                type: 'curiosity_momentum_error',
                goalId: row.goalId,
                ownerAgentId: row.ownerAgentId || '',
                title: row.title,
                message: row.error,
              });
              continue;
            }
            if (row.skipped) continue;
            onLog({
              type: row.hasSafeNextStep ? 'curiosity_suggestion' : 'curiosity_idle_check',
              goalId: row.goalId,
              ownerAgentId: row.ownerAgentId || '',
              title: row.title,
              message: row.suggestion || row.summary || `Idle check on ${row.title}`,
              details: {
                goalId: row.goalId,
                title: row.title,
                hasSafeNextStep: row.hasSafeNextStep === true,
                suggestion: row.suggestion || '',
                safeNextStep: row.safeNextStep || '',
                rationale: row.rationale || '',
              },
            });
          }
        }
      } catch (_) {}
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
