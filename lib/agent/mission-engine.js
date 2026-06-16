import { processDueMissionsInStore, runMissionTick, recoverStaleMissions } from '../context/missions.js';
import { analyzeTeamActivityForSuggestedTasks } from '../context/ai-suggested-tasks.js';
import { runCuriosityMomentumCycle } from './curiosity-momentum.js';
import { isDailyLimitReached, msUntilLimitResets } from '../../llm.js';
import {
  startRequestTrace,
  runWithRequestTrace,
  logRequestStart,
  logRequestEnd,
  traceAsyncStep,
} from '../util/request-timing.js';

let timer = null;
let running = false;

function clampLoopMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 45 * 60_000;
  return Math.max(30_000, Math.min(120 * 60_000, Math.floor(n)));
}

function clampCuriosityMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 150 * 60_000;
  return Math.max(60_000, Math.min(24 * 60 * 60_000, Math.floor(n)));
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
  const curiosityIntervalMs = clampCuriosityMs(opts.curiosityIntervalMs);
  const runMissionTurn = typeof opts.runMissionTurn === 'function' ? opts.runMissionTurn : null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  if (!runMissionTurn) throw new Error('startMissionEngine requires runMissionTurn');
  let lastCuriosityRun = 0;

  async function cycle() {
    if (running) return;
    if (isDailyLimitReached()) {
      const hoursLeft = Math.ceil(msUntilLimitResets() / 3_600_000);
      console.log(`[mission-engine] Daily LLM limit reached — skipping cycle. Resets in ~${hoursLeft}h.`);
      return;
    }
    running = true;
    try {
      try { recoverStaleMissions(); } catch (_) {}
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
          const trace = startRequestTrace({
            source: 'mission_tick',
            agentId: mission.ownerAgentId || 'main',
            userPreview: mission.title || mission.id,
            jid: '',
          });
          let tickStatus = 'ok';
          const result = await runWithRequestTrace(trace, async () => {
            logRequestStart(trace);
            try {
              return await traceAsyncStep('mission_tick', () => runMissionTick(mission.id, { runMissionTurn }), {
                missionId: mission.id,
                title: mission.title,
              });
            } catch (err) {
              tickStatus = 'error';
              throw err;
            } finally {
              logRequestEnd(trace, tickStatus, { missionId: mission.id });
            }
          });
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
      if (Date.now() - lastCuriosityRun >= curiosityIntervalMs) {
      try {
        lastCuriosityRun = Date.now();
        const curiosityTrace = startRequestTrace({ source: 'curiosity_momentum', agentId: 'main' });
        const curiosity = await runWithRequestTrace(curiosityTrace, async () => {
          logRequestStart(curiosityTrace);
          try {
            const result = await traceAsyncStep('curiosity_cycle', () => runCuriosityMomentumCycle({
              runMissionTurn,
              excludeMissionIds: tickedMissionIds,
            }));
            logRequestEnd(curiosityTrace, 'ok');
            return result;
          } catch (err) {
            logRequestEnd(curiosityTrace, 'error', { error: err.message });
            throw err;
          }
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
      } // end curiosity interval gate
    } finally {
      running = false;
    }
  }

  try { recoverStaleMissions(); } catch (_) {}

  timer = setInterval(() => {
    cycle().catch(() => {});
  }, loopMs);
  setTimeout(() => {
    cycle().catch(() => {});
  }, 2_000);
}
