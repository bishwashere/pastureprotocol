/**
 * Unit tests for chat background tasks (spawn, list, cancel, stale recovery).
 * Uses a mock agent turn and mock sock — no LLM required.
 *
 * Usage: node scripts/test/test-background-tasks.js
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = mkdtempSync(join(tmpdir(), 'pasture-bg-tasks-'));
mkdirSync(join(stateDir, 'workspace'), { recursive: true });
writeFileSync(
  join(stateDir, 'config.json'),
  JSON.stringify({ agents: { defaults: { userTimezone: 'UTC' } } }, null, 2),
  'utf8'
);
process.env.PASTURE_STATE_DIR = stateDir;

const {
  spawnBackgroundTask,
  formatTasksList,
  cancelBackgroundTask,
  listTasksForJid,
  recoverStaleBackgroundTasks,
  _setBackgroundRunTurnForTests,
} = await import('../../lib/agent/background-tasks.js');
const { executeBackgroundTasks } = await import('../../lib/agent/executors/background-tasks.js');
const { getEnabledSkillIds } = await import('../../skills/loader.js');

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

function mockSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, payload) => {
      sent.push({ jid, text: payload?.text });
      return { key: { id: 'mock-msg' } };
    },
  };
}

function baseCtx(overrides = {}) {
  const sock = mockSock();
  return {
    jid: '12345',
    agentId: 'main',
    workspaceDir: join(stateDir, 'workspace'),
    storePath: join(stateDir, 'cron', 'jobs.json'),
    scheduleOneShot: () => {},
    startCron: () => {},
    isGroup: false,
    sock,
    ...overrides,
  };
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function main() {
  console.log('Test: background-tasks (chat sub-agents).\n');

  // Stale recovery
  const storePath = join(stateDir, 'background-tasks', 'tasks.json');
  mkdirSync(join(stateDir, 'background-tasks'), { recursive: true });
  writeFileSync(
    storePath,
    JSON.stringify({
      tasks: [{
        id: 'stale-task-id',
        jid: '999',
        prompt: 'old work',
        status: 'running',
        createdAtMs: Date.now() - 60_000,
        updatedAtMs: Date.now() - 60_000,
      }],
    }, null, 2),
    'utf8'
  );
  recoverStaleBackgroundTasks(storePath);
  const stale = listTasksForJid('999', storePath)[0];
  check('recover: running -> failed on restart', stale?.status === 'failed' && /restart/.test(stale?.error || ''));

  check('implicit: always in enabled skill ids', getEnabledSkillIds({ agentId: 'main' }).includes('background-tasks'));

  // Mock fast background turn
  _setBackgroundRunTurnForTests(async () => ({
    textToSend: 'Background result text',
    skillsCalled: ['search'],
  }));

  const ctx = baseCtx();
  ctx.spawnBackgroundTask = (opts) => spawnBackgroundTask({ ...opts, ctx });

  // Spawn validation
  check('reject: empty prompt', spawnBackgroundTask({ prompt: '', ctx }).ok === false);
  check('reject: no sock', spawnBackgroundTask({ prompt: 'hi', ctx: { jid: '1' } }).ok === false);
  check('reject: nested spawn', spawnBackgroundTask({ prompt: 'hi', ctx: { ...ctx, isBackgroundTask: true } }).ok === false);

  // Happy path spawn + announce
  const spawn = spawnBackgroundTask({ prompt: 'Research competitors', label: 'Research', ctx });
  check('spawn: returns task id', spawn.ok && spawn.taskId && spawn.shortId);
  const listed = listTasksForJid(ctx.jid);
  check('spawn: task is running', listed.some((t) => t.id === spawn.taskId && t.status === 'running'));

  const done = await waitFor(() => listTasksForJid(ctx.jid).find((t) => t.id === spawn.taskId)?.status === 'done');
  check('spawn: completes asynchronously', done);
  check('spawn: announces to chat', ctx.sock.sent.length >= 1 && /Background result text/.test(ctx.sock.sent[0]?.text || ''));

  // Executor spawn
  const spawnViaTool = parse(await executeBackgroundTasks(ctx, { prompt: 'Another task', label: 'Another' }, 'background_tasks_spawn'));
  check('executor spawn: ok', spawnViaTool.taskId && spawnViaTool.status === 'running');

  // List via executor and /tasks formatter
  const listText = await executeBackgroundTasks(ctx, {}, 'background_tasks_list');
  check('executor list: includes running', /Background tasks/.test(listText));
  const formatted = formatTasksList(ctx.jid);
  check('formatTasksList: non-empty', formatted.includes('Background tasks'));

  // Cancel running task
  const running = spawnBackgroundTask({ prompt: 'to cancel', ctx });
  check('cancel setup: spawned', running.ok);
  const cancel = cancelBackgroundTask(ctx.jid, running.shortId);
  check('cancel: ok', cancel.ok);
  const cancelled = listTasksForJid(ctx.jid).find((t) => t.id === running.taskId);
  check('cancel: status cancelled', cancelled?.status === 'cancelled');

  // Cap: max 3 running
  const capCtx = baseCtx({ jid: 'cap-test' });
  capCtx.spawnBackgroundTask = (opts) => spawnBackgroundTask({ ...opts, ctx: capCtx });
  _setBackgroundRunTurnForTests(() => new Promise(() => {})); // never resolves
  spawnBackgroundTask({ prompt: 'a', ctx: capCtx });
  spawnBackgroundTask({ prompt: 'b', ctx: capCtx });
  spawnBackgroundTask({ prompt: 'c', ctx: capCtx });
  const fourth = spawnBackgroundTask({ prompt: 'd', ctx: capCtx });
  check('cap: fourth spawn blocked', !fourth.ok && /Too many running/.test(fourth.error || ''));

  _setBackgroundRunTurnForTests(async () => ({ textToSend: 'ok', skillsCalled: [] }));

  console.log(`\nResult: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('background-tasks test crashed:', e);
  process.exit(1);
});
