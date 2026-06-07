import { processDueMissionsInStore, runMissionTick } from './missions.js';
import { analyzeTeamActivityForSuggestedTasks } from './ai-suggested-tasks.js';
import { runCuriosityMomentumCycle } from './curiosity-momentum.js';

let timer = null;
let running = false;

function clampLoopMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 30_000;
  return Math.max(30_000, Math.min(300_000, Math.floor(n)));
}

export function stopMissionEngine() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function startMissionEngine(opts = {}) {
  if (timer) return;
  const loopMs = clampLoopMs(opts.loopMs);
  const runMissionTurn = typeof opts.runMissionTurn === 'function' ? opts.runMissionTurn : null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!runMissionTurn) throw new Error('startMissionEngine requires runMissionTurn');

  async function cycle() {
    if (running) return;
    running = true;
    try {
      try {
        const analysis = analyzeTeamActivityForSuggestedTasks({ minIntervalMs: 3 * 60 * 60_000 });
        if (analysis && !analysis.skipped && ((analysis.created && analysis.created.length) || (analysis.merged && analysis.merged.length))) {
          onLog({
            type: 'suggestedTask_scan_done',
            message: `SuggestedTask scan created=${analysis.created?.length || 0} merged=${analysis.merged?.length || 0}`,
          });
        }
      } catch (_) {}
      const tickedMissionIds = [];
      const due = processDueMissionsInStore({ maxPerCycle: 4 });
      for (const mission of due) {
        try {
          onLog({ type: 'mission_tick_start', missionId: mission.id, ownerAgentId: mission.ownerAgentId, title: mission.title });
          const result = await runMissionTick(mission.id, { runMissionTurn });
          tickedMissionIds.push(mission.id);
          onLog({
            type: result?.error ? 'mission_tick_error' : 'mission_tick_done',
            missionId: mission.id,
            ownerAgentId: mission.ownerAgentId,
            title: mission.title,
            status: result?.mission?.status || '',
            message: result?.mission?.lastActivity || '',
          });
          if (Array.isArray(result?.createdTasks) && result.createdTasks.length) {
            for (const child of result.createdTasks) {
              onLog({
                type: 'mission_task_created',
                missionId: mission.id,
                taskId: child.id || '',
                ownerAgentId: child.ownerAgentId || child.assignee || mission.ownerAgentId,
                title: child.title,
                message: `Task created: ${child.title}`,
              });
            }
          }
        } catch (err) {
          tickedMissionIds.push(mission.id);
          onLog({
            type: 'mission_tick_error',
            missionId: mission.id,
            ownerAgentId: mission.ownerAgentId,
            title: mission.title,
            message: err?.message || String(err),
          });
        }
      }
      try {
        const curiosity = await runCuriosityMomentumCycle({
          runMissionTurn,
          excludeMissionIds: tickedMissionIds,
        });
        if (curiosity?.results?.length) {
          for (const row of curiosity.results) {
            if (row.error) {
              onLog({
                type: 'curiosity_momentum_error',
                missionId: row.missionId,
                ownerAgentId: row.ownerAgentId || '',
                title: row.title,
                message: row.error,
              });
              continue;
            }
            if (row.skipped) continue;
            onLog({
              type: row.hasSafeNextStep ? 'curiosity_suggestion' : 'curiosity_idle_check',
              missionId: row.missionId,
              ownerAgentId: row.ownerAgentId || '',
              title: row.title,
              message: row.suggestion || row.summary || `Idle check on ${row.title}`,
              details: {
                missionId: row.missionId,
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
