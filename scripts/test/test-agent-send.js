/**
 * Unit/integration test for agent-to-agent messaging (agent-send skill).
 * Deterministic: injects a mock internal runner so no LLM is required.
 * Verifies the executor guards (args, self, unknown, allow list, loop, depth,
 * per-turn cap), the happy path, and getAgentMessagingPolicy defaults/overrides.
 *
 * Usage: node scripts/test/test-agent-send.js
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-agent-send-'));
mkdirSync(join(stateDir, 'workspace'), { recursive: true });
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
  'utf8'
);
process.env.COWCODE_STATE_DIR = stateDir;

const { ensureAgent, saveAgentConfig, loadAgentConfig, getAgentMessagingPolicy } = await import('../../lib/agent-config.js');
const { executeAgentSend } = await import('../../lib/executors/agent-send.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function parse(result) {
  try {
    return JSON.parse(result);
  } catch {
    return { _raw: result };
  }
}

function isError(result) {
  return typeof result === 'string' && result.trim().startsWith('{"error":');
}

// --- Setup agents: pm (caller) may message backend, not reviewer ---
ensureAgent('main');
ensureAgent('pm');
ensureAgent('backend');
ensureAgent('reviewer');
saveAgentConfig('pm', {
  skills: { enabled: ['agent-send'] },
  agentMessaging: { allow: ['backend'], maxDepth: 2, maxCallsPerTurn: 2 },
});

// Mock runner: records calls, echoes a canned reply for the target.
const calls = [];
function mockRunner(opts) {
  calls.push(opts);
  return Promise.resolve({ textToSend: `[${opts.targetAgentId}] handled: ${opts.userText}`, skillsCalled: [], agentId: opts.targetAgentId });
}

function baseCtx(overrides = {}) {
  return {
    agentId: 'pm',
    runInternalAgent: mockRunner,
    agentDepth: 0,
    agentCallChain: ['pm'],
    ...overrides,
  };
}

async function main() {
  console.log('Test: agent-send (agent-to-agent messaging).\n');

  // Policy helper
  const pmPolicy = getAgentMessagingPolicy('pm');
  check('policy: allow parsed', pmPolicy.allow.includes('backend'), JSON.stringify(pmPolicy));
  check('policy: maxCallsPerTurn override', pmPolicy.maxCallsPerTurn === 2);
  const defPolicy = getAgentMessagingPolicy('backend');
  check('policy: defaults when unset', defPolicy.maxDepth === 2 && defPolicy.maxCallsPerTurn === 5 && defPolicy.allow.length === 0);

  // Missing args
  check('reject: missing agent', isError(await executeAgentSend(baseCtx(), { message: 'hi' })));
  check('reject: missing message', isError(await executeAgentSend(baseCtx(), { agent: 'backend' })));

  // Self message
  check('reject: self message', isError(await executeAgentSend(baseCtx(), { agent: 'pm', message: 'hi' })));

  // Unknown agent
  check('reject: unknown agent', isError(await executeAgentSend(baseCtx(), { agent: 'ghost', message: 'hi' })));

  // Not in allow list (reviewer exists but not allowed)
  const notAllowed = await executeAgentSend(baseCtx(), { agent: 'reviewer', message: 'hi' });
  check('reject: not linked', isError(notAllowed) && /not linked/i.test(notAllowed));

  // Loop guard (target already in chain)
  check(
    'reject: loop in chain',
    isError(await executeAgentSend(baseCtx({ agentCallChain: ['pm', 'backend'] }), { agent: 'backend', message: 'hi' }))
  );

  // Depth limit (depth already at maxDepth → next would exceed)
  check(
    'reject: depth limit',
    isError(await executeAgentSend(baseCtx({ agentDepth: 2 }), { agent: 'backend', message: 'hi' }))
  );

  // Happy path
  calls.length = 0;
  const ok = await executeAgentSend(baseCtx(), { agent: 'backend', message: 'design auth' });
  const okParsed = parse(ok);
  check('happy: not an error', !isError(ok), ok);
  check('happy: reply returned', okParsed.agent === 'backend' && /handled: design auth/.test(okParsed.reply || ''));
  check('happy: runner invoked with depth+1', calls.length === 1 && calls[0].depth === 1);
  check('happy: chain extended', calls.length === 1 && Array.isArray(calls[0].callChain) && calls[0].callChain.join('>') === 'pm>backend');

  saveAgentConfig('backend', { ...loadAgentConfig('backend'), title: 'Backend Bot' });
  calls.length = 0;
  const byTitle = await executeAgentSend(baseCtx(), { agent: 'Backend Bot', message: 'via title' });
  check('happy: resolve target by title', !isError(byTitle) && parse(byTitle).agent === 'backend');

  // Per-turn cap (maxCallsPerTurn = 2): reuse one ctx across calls
  const turnCtx = baseCtx();
  const c1 = await executeAgentSend(turnCtx, { agent: 'backend', message: 'one' });
  const c2 = await executeAgentSend(turnCtx, { agent: 'backend', message: 'two' });
  const c3 = await executeAgentSend(turnCtx, { agent: 'backend', message: 'three' });
  check('cap: first two allowed', !isError(c1) && !isError(c2));
  check('cap: third blocked', isError(c3), c3);

  // No runner on ctx (e.g. cron/group context)
  check(
    'reject: no internal runner',
    isError(await executeAgentSend({ agentId: 'pm', agentDepth: 0, agentCallChain: ['pm'] }, { agent: 'backend', message: 'hi' }))
  );

  console.log(`\nResult: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('agent-send test crashed:', e);
  process.exit(1);
});
