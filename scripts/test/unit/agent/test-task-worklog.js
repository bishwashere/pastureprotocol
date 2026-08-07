#!/usr/bin/env node

import assert from 'assert';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TASK_WORKLOG_MAX_BYTES,
  TASK_WORKLOG_MAX_CHECKPOINTS,
  appendTaskWorklogCheckpoint,
  ensureTaskWorklog,
  finalizeTaskWorklog,
  formatTaskWorklogPromptBlock,
  pruneTaskWorklogs,
  readTaskWorklog,
  recordTaskWorklogToolEvent,
  redactTaskWorklogText,
  taskWorklogExists,
} from '../../../../lib/context/task-worklog.js';
import { executeWorklog } from '../../../../lib/agent/executors/worklog.js';
import { getTaskWorklogPath, getTaskWorklogsDir } from '../../../../lib/util/paths.js';
import {
  getEnabledSkillIds,
  getSkillContext,
  UI_HIDDEN_SKILL_IDS,
} from '../../../../skills/loader.js';

const originalStateDir = process.env.PASTURE_STATE_DIR;
const root = mkdtempSync(join(tmpdir(), 'pasture-task-worklog-'));
process.env.PASTURE_STATE_DIR = join(root, 'state');

try {
  const ctx = {
    taskWorklogId: 'run-primary-123',
    agentId: 'main',
    logKey: 'private-chat/session-one',
  };
  const created = ensureTaskWorklog(ctx, {
    title: 'Inspect every project',
    objective: 'Collect status and verified counts',
  });
  assert(created, 'ensure creates a worklog for a valid context id');
  assert(taskWorklogExists(ctx), 'exists is scoped to the context id');

  const path = getTaskWorklogPath(ctx.taskWorklogId);
  assert(existsSync(path), 'per-run file exists');
  if (process.platform !== 'win32') {
    assert.strictEqual(statSync(getTaskWorklogsDir()).mode & 0o777, 0o700, 'worklog directory is 0700');
    assert.strictEqual(statSync(path).mode & 0o777, 0o600, 'worklog file is 0600');
  }

  assert.throws(
    () => getTaskWorklogPath('../escape'),
    /Invalid task worklog id/,
    'path traversal ids are rejected',
  );
  assert.strictEqual(ensureTaskWorklog({ taskWorklogId: '../escape' }), null, 'invalid context ids do not create files');
  assert.strictEqual(
    readTaskWorklog({ ...ctx, logKey: 'private-chat/session-two' }),
    null,
    'a different chat/session scope cannot read a known worklog id',
  );

  const secretText = [
    'password=hunter2',
    'mongodb+srv://dbuser:dbpass@example.test/app',
    'Authorization: Bearer token-value-123456',
    'api_key="super-secret-value"',
    'AWS_SECRET_ACCESS_KEY=aws-value with spaces',
    'GITHUB_TOKEN=github-value',
    'NPM_TOKEN=npm-value',
    '"openai_api_key": "json-secret-value"',
    'safe count: 814',
  ].join('\n');
  const redacted = redactTaskWorklogText(secretText);
  assert(!redacted.includes('hunter2'), 'passwords are redacted');
  assert(!redacted.includes('dbpass'), 'URI credentials are redacted');
  assert(!redacted.includes('token-value'), 'authorization values are redacted');
  assert(!redacted.includes('super-secret-value'), 'API keys are redacted');
  assert(!redacted.includes('aws-value'), 'prefixed AWS secret keys are redacted');
  assert(!redacted.includes('github-value'), 'prefixed token keys are redacted');
  assert(!redacted.includes('npm-value'), 'NPM token assignments are redacted');
  assert(!redacted.includes('json-secret-value'), 'prefixed JSON API-key fields are redacted');
  assert(
    !redactTaskWorklogText('-----BEGIN PRIVATE KEY-----\ntruncated-private-material').includes('truncated-private-material'),
    'unterminated private-key blocks are redacted',
  );
  assert(redacted.includes('safe count: 814'), 'safe findings remain available');
  assert(redactTaskWorklogText('abcdef', 4).length <= 4, 'public redactor also enforces a caller bound');

  const checkpointResult = JSON.parse(await executeWorklog(ctx, {
    // Deliberately ignored: callers cannot select another run through args.
    taskWorklogId: 'run-attacker-selected',
    label: 'Database check',
    summary: secretText,
    nextStep: 'Inspect deployment status',
  }, 'worklog_checkpoint'));
  assert.strictEqual(checkpointResult.ok, true, 'checkpoint executor succeeds');
  assert(!existsSync(getTaskWorklogPath('run-attacker-selected')), 'argument-supplied run id is never used');

  recordTaskWorklogToolEvent(ctx, {
    skillId: 'mongodb',
    toolName: 'mongodb_stats',
    ok: true,
    durationMs: 42,
    args: { uri: 'mongodb://user:password@example.test/db' },
    result: 'raw sensitive database output',
    error: 'Authorization: Bearer should-not-be-saved',
  });
  let worklog = readTaskWorklog(ctx);
  assert.strictEqual(worklog.toolEvents.length, 1, 'tool metadata is recorded');
  assert.deepStrictEqual(
    Object.keys(worklog.toolEvents[0]).sort(),
    ['at', 'durationMs', 'ok', 'sequence', 'skillId', 'toolName'].sort(),
    'tool event persists only the metadata whitelist',
  );
  let raw = readFileSync(path, 'utf8');
  assert(!raw.includes(ctx.logKey), 'scope binding is stored as a fingerprint, not a chat identifier');
  assert(!raw.includes('raw sensitive database output'), 'tool results are not persisted');
  assert(!raw.includes('should-not-be-saved'), 'tool errors are not persisted');
  assert(!raw.includes('dbpass') && !raw.includes('hunter2'), 'checkpoint secrets do not reach disk');

  for (let idx = 0; idx < TASK_WORKLOG_MAX_CHECKPOINTS + 8; idx++) {
    appendTaskWorklogCheckpoint(ctx, {
      label: `Project ${idx}`,
      summary: `Verified project ${idx} status and safe metric ${idx}. ${'x'.repeat(200)}`,
    });
  }
  worklog = readTaskWorklog(ctx);
  assert.strictEqual(
    worklog.checkpoints.length,
    TASK_WORKLOG_MAX_CHECKPOINTS,
    'only the bounded checkpoint tail is retained',
  );
  assert(worklog.counts.checkpoints > worklog.checkpoints.length, 'total count survives tail pruning');
  assert(statSync(path).size <= TASK_WORKLOG_MAX_BYTES, 'per-run file size is bounded');

  const promptBlock = formatTaskWorklogPromptBlock(ctx);
  assert(promptBlock.includes('Durable task worklog'), 'prompt reinjection block is formatted');
  assert(promptBlock.includes('Verified project'), 'prompt block carries checkpoint findings');
  assert(!promptBlock.includes(ctx.taskWorklogId), 'prompt block does not reveal the storage id');
  assert(!promptBlock.includes('hunter2') && !promptBlock.includes('dbpass'), 'prompt block remains redacted');

  const readResult = JSON.parse(await executeWorklog(ctx, {}, 'worklog_read'));
  assert.strictEqual(readResult.ok, true, 'read executor succeeds');
  assert(readResult.promptBlock.includes('Checkpoints:'), 'read executor returns synthesis-ready notes');
  assert(!JSON.stringify(readResult).includes(ctx.taskWorklogId), 'read executor omits internal run identity');

  const finalized = finalizeTaskWorklog(ctx, {
    status: 'completed',
    summary: 'All projects checked; access_token=final-secret',
  });
  assert.strictEqual(finalized.status, 'completed', 'finalize records terminal status');
  assert(finalized.finalizedAt, 'finalize records a timestamp');
  assert(!finalized.finalSummary.includes('final-secret'), 'final summary is redacted');

  const missingCtx = JSON.parse(await executeWorklog({}, { summary: 'x' }, 'worklog_checkpoint'));
  assert(missingCtx.error, 'executor requires a context-selected worklog');

  const enabledIds = getEnabledSkillIds();
  assert(enabledIds.includes('worklog'), 'worklog is an implicit chat skill');
  assert(UI_HIDDEN_SKILL_IDS.has('worklog'), 'worklog is hidden from skill toggles');
  const narrowed = getSkillContext({ hintSkills: ['read'] });
  const narrowedTools = narrowed.runSkillTool.map((tool) => tool.function.name);
  assert(narrowedTools.includes('worklog_checkpoint'), 'checkpoint remains loaded after hint narrowing');
  assert(narrowedTools.includes('worklog_read'), 'read remains loaded after hint narrowing');

  const expiredCtx = { taskWorklogId: 'run-expired-123' };
  ensureTaskWorklog(expiredCtx);
  const expiredPath = getTaskWorklogPath(expiredCtx.taskWorklogId);
  const old = new Date(Date.now() - 60_000);
  utimesSync(expiredPath, old, old);
  pruneTaskWorklogs({ now: Date.now(), ttlMs: 1_000 });
  assert(!existsSync(expiredPath), 'TTL pruning removes expired worklogs');

  for (let idx = 0; idx < 5; idx++) ensureTaskWorklog({ taskWorklogId: `run-cap-${idx}` });
  pruneTaskWorklogs({ ttlMs: 60_000, maxFiles: 2 });
  const remaining = readdirSync(getTaskWorklogsDir()).filter((name) => name.endsWith('.json'));
  assert(remaining.length <= 2, 'file-count pruning enforces the global cap');

  console.log('test-task-worklog passed');
} finally {
  if (originalStateDir == null) delete process.env.PASTURE_STATE_DIR;
  else process.env.PASTURE_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
}
