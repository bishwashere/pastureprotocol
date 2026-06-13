/**
 * Unit tests for request timing logs.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const stateDir = mkdtempSync(join(tmpdir(), 'pasture-timing-test-'));
process.env.PASTURE_STATE_DIR = stateDir;

const {
  startRequestTrace,
  runWithRequestTrace,
  logRequestStart,
  logRequestEnd,
  traceAsyncStep,
  beginLlmCall,
  endLlmCall,
} = await import('../../lib/request-timing.js');
const { getRequestTimingLogPath } = await import('../../lib/paths.js');

function readRows() {
  const raw = readFileSync(getRequestTimingLogPath(), 'utf8').trim();
  return raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
}

async function run() {
  const trace = startRequestTrace({
    jid: '7656021862',
    channel: 'telegram',
    receivedAtMs: Date.now() - 5000,
    userPreview: 'what missions are active today?',
    agentId: 'main',
  });

  await runWithRequestTrace(trace, async () => {
    logRequestStart(trace);
    await traceAsyncStep('work_durability', async () => {
      const llm = beginLlmCall({ purpose: 'work_durability_classify', model: 'local', agentId: 'main' });
      await new Promise((r) => setTimeout(r, 5));
      endLlmCall(llm, { model: 'local', status: 'ok' });
    });
    logRequestEnd(trace, 'ok', { skillsCalled: [] });
  });

  const rows = readRows();
  const types = rows.map((r) => r.type);
  const required = ['request_start', 'step_start', 'step_end', 'llm_start', 'llm_end', 'request_end'];
  for (const t of required) {
    if (!types.includes(t)) throw new Error(`missing timing event: ${t}`);
  }
  const requestEnd = rows.find((r) => r.type === 'request_end');
  if (!requestEnd?.durationMs || requestEnd.durationMs < 1) {
    throw new Error('request_end missing durationMs');
  }
  const llmEnd = rows.find((r) => r.type === 'llm_end');
  if (!llmEnd?.purpose || llmEnd.purpose !== 'work_durability_classify') {
    throw new Error('llm_end missing purpose');
  }
  if (requestEnd.traceId !== trace.id) throw new Error('traceId not propagated');

  console.log('test-request-timing: pass');
}

run()
  .catch((err) => {
    console.error('test-request-timing: fail', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  });
