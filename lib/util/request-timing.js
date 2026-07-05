/**
 * Structured request timing logs for later analysis.
 * Writes JSONL to ~/.pasture/request-timing.jsonl and mirrors summary lines to daemon.log as [timing].
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { getRequestTimingLogPath } from './paths.js';

const traceStore = new AsyncLocalStorage();

/** Active LLM calls (observed concurrency — does not serialize calls). */
let llmInFlight = 0;

function summarizeText(text, max = 80) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
}

function normalizeRow(row) {
  const trace = getActiveTrace();
  const ts = Number(row.ts) || Date.now();
  const out = {
    ts,
    type: String(row.type || 'event'),
    traceId: row.traceId != null ? String(row.traceId) : (trace?.id || ''),
    source: row.source != null ? String(row.source) : (trace?.source || ''),
    jid: row.jid != null ? String(row.jid) : (trace?.jid || ''),
    agentId: row.agentId != null ? String(row.agentId) : (trace?.agentId || ''),
    phase: row.phase != null ? String(row.phase) : '',
    purpose: row.purpose != null ? String(row.purpose) : '',
    durationMs: Number.isFinite(Number(row.durationMs)) ? Math.max(0, Math.round(Number(row.durationMs))) : undefined,
    elapsedMs: Number.isFinite(Number(row.elapsedMs)) ? Math.max(0, Math.round(Number(row.elapsedMs))) : undefined,
    status: row.status != null ? String(row.status) : '',
    model: row.model != null ? String(row.model) : '',
    inFlightAtStart: Number.isFinite(Number(row.inFlightAtStart)) ? Number(row.inFlightAtStart) : undefined,
    toolCount: Number.isFinite(Number(row.toolCount)) ? Number(row.toolCount) : undefined,
    channelWaitMs: Number.isFinite(Number(row.channelWaitMs)) ? Math.max(0, Math.round(Number(row.channelWaitMs))) : undefined,
    message: row.message != null ? String(row.message) : '',
    detail: row.detail && typeof row.detail === 'object' ? row.detail : undefined,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === '') delete out[key];
  }
  return out;
}

function appendTimingRow(row) {
  try {
    const logPath = getRequestTimingLogPath();
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, JSON.stringify(row) + '\n', 'utf8');
  } catch (_) {
    // Timing must never break runtime paths.
  }
}

// Event types that are surfaced in daemon.log. All events always go to JSONL.
const CONSOLE_EVENT_TYPES = new Set(['request_start', 'request_end']);

const FLOW_STEP_BY_PHASE = Object.freeze({
  work_mode_controller: '3 WORK MODE',
  task_frame: '4 TASK FRAME',
  unified_turn_planner: '7 PLANNER',
  forced_delegation: '9 DELEGATE',
  agent_turn: '10 RUN AGENT',
  planned_tool_retry: '12 RETRY',
  task_frame_status: '13 TASK STATUS',
});

function flowStepForPhase(phase) {
  return FLOW_STEP_BY_PHASE[String(phase || '')] || '';
}

export function logTiming(event = {}) {
  const trace = getActiveTrace();
  const row = normalizeRow({
    ...event,
    ts: event.ts || Date.now(),
    elapsedMs: trace ? Date.now() - trace.startedAt : event.elapsedMs,
  });
  appendTimingRow(row);
  if (CONSOLE_EVENT_TYPES.has(row.type)) {
    // Compact one-liner: source, phase/purpose, duration, status
    const parts = [row.source || row.type];
    if (row.message) parts.push(`"${row.message}"`);
    if (row.durationMs != null) parts.push(`${(row.durationMs / 1000).toFixed(1)}s`);
    if (row.status && row.status !== 'ok') parts.push(row.status);
    console.log(`[timing:${row.type}]`, parts.join(' | '));
  }
}

export function getActiveTrace() {
  return traceStore.getStore() || null;
}

export function startRequestTrace(meta = {}) {
  const now = Date.now();
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: now,
    lastMarkAt: now,
    steps: [],
    jid: meta.jid != null ? String(meta.jid) : '',
    channel: meta.channel != null ? String(meta.channel) : '',
    source: meta.source != null ? String(meta.source) : 'user_message',
    agentId: meta.agentId != null ? String(meta.agentId) : 'main',
    receivedAtMs: Number.isFinite(Number(meta.receivedAtMs)) ? Number(meta.receivedAtMs) : null,
    userPreview: summarizeText(meta.userPreview || meta.userText || '', 100),
  };
}

export function runWithRequestTrace(trace, fn) {
  if (!trace || typeof fn !== 'function') return fn();
  return traceStore.run(trace, fn);
}

function recordStep(trace, phase, durationMs, status, detail) {
  if (!trace) return;
  trace.steps.push({
    phase,
    durationMs,
    status,
    at: Date.now(),
    detail: detail && typeof detail === 'object' ? detail : undefined,
  });
  trace.lastMarkAt = Date.now();
}

export function logRequestStart(trace) {
  if (!trace) return;
  const channelWaitMs = trace.receivedAtMs != null ? Math.max(0, trace.startedAt - trace.receivedAtMs) : undefined;
  logTiming({
    type: 'request_start',
    traceId: trace.id,
    source: trace.source,
    jid: trace.jid,
    agentId: trace.agentId,
    channelWaitMs,
    message: trace.userPreview,
    detail: {
      channel: trace.channel || undefined,
      receivedAtMs: trace.receivedAtMs || undefined,
    },
  });
}

export function logRequestEnd(trace, status = 'ok', detail = {}) {
  if (!trace) return;
  const durationMs = Date.now() - trace.startedAt;
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  logTiming({
    type: 'request_end',
    traceId: trace.id,
    source: trace.source,
    jid: trace.jid,
    agentId: trace.agentId,
    durationMs,
    status,
    message: trace.userPreview,
    detail: {
      steps: steps.map((s) => ({
        phase: s.phase,
        durationMs: s.durationMs,
        status: s.status,
      })),
      ...detail,
    },
  });
}

export async function traceAsyncStep(phase, fn, detail = null) {
  const trace = getActiveTrace();
  const start = Date.now();
  const previousFlowStep = trace?.flowStep || '';
  const phaseFlowStep = flowStepForPhase(phase);
  if (trace && phaseFlowStep) trace.flowStep = phaseFlowStep;
  logTiming({
    type: 'step_start',
    phase,
    detail: detail || undefined,
  });
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    recordStep(trace, phase, durationMs, 'ok', detail);
    logTiming({
      type: 'step_end',
      phase,
      durationMs,
      status: 'ok',
      detail: detail || undefined,
    });
    if (trace && phaseFlowStep) trace.flowStep = previousFlowStep;
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    recordStep(trace, phase, durationMs, 'error', detail);
    logTiming({
      type: 'step_end',
      phase,
      durationMs,
      status: 'error',
      message: err?.message || String(err),
      detail: detail || undefined,
    });
    if (trace && phaseFlowStep) trace.flowStep = previousFlowStep;
    throw err;
  }
}

export function traceSyncStep(phase, fn, detail = null) {
  const trace = getActiveTrace();
  const start = Date.now();
  logTiming({ type: 'step_start', phase, detail: detail || undefined });
  try {
    const result = fn();
    const durationMs = Date.now() - start;
    recordStep(trace, phase, durationMs, 'ok', detail);
    logTiming({
      type: 'step_end',
      phase,
      durationMs,
      status: 'ok',
      detail: detail || undefined,
    });
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    recordStep(trace, phase, durationMs, 'error', detail);
    logTiming({
      type: 'step_end',
      phase,
      durationMs,
      status: 'error',
      message: err?.message || String(err),
      detail: detail || undefined,
    });
    throw err;
  }
}

export function beginLlmCall(meta = {}) {
  const inFlightAtStart = llmInFlight + 1;
  llmInFlight = inFlightAtStart;
  const ctx = {
    startedAt: Date.now(),
    purpose: meta.purpose != null ? String(meta.purpose) : 'llm',
    model: meta.model != null ? String(meta.model) : '',
    agentId: meta.agentId != null ? String(meta.agentId) : '',
    inFlightAtStart,
    toolCount: Number.isFinite(Number(meta.toolCount)) ? Number(meta.toolCount) : undefined,
  };
  logTiming({
    type: 'llm_start',
    purpose: ctx.purpose,
    model: ctx.model,
    agentId: ctx.agentId,
    inFlightAtStart: ctx.inFlightAtStart,
    toolCount: ctx.toolCount,
    detail: meta.detail && typeof meta.detail === 'object' ? meta.detail : undefined,
  });
  return ctx;
}

export function endLlmCall(ctx, result = {}) {
  if (!ctx) return;
  llmInFlight = Math.max(0, llmInFlight - 1);
  const durationMs = Date.now() - ctx.startedAt;
  logTiming({
    type: 'llm_end',
    purpose: ctx.purpose,
    model: result.model || ctx.model,
    agentId: ctx.agentId,
    durationMs,
    inFlightAtStart: ctx.inFlightAtStart,
    inFlightAtEnd: llmInFlight,
    toolCount: result.toolCount != null ? result.toolCount : ctx.toolCount,
    status: result.status || 'ok',
    message: result.message || '',
    detail: result.detail && typeof result.detail === 'object' ? result.detail : undefined,
  });
}

export function getLlmInFlightCount() {
  return llmInFlight;
}
