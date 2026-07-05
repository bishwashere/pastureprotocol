#!/usr/bin/env node

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-task-frame-test-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ agents: { defaults: {} } }), 'utf8');
  process.env.PASTURE_STATE_DIR = stateDir;
}

async function main() {
  setupStateDir();

  const { loadPrompt } = await import('../../../../lib/agent/md-llm.js');
  const {
    classifyTaskFrameTurn,
    clearTaskFrame,
    getActiveTaskFrame,
    shouldUseTaskFrameFastPath,
    taskFrameDecisionToTurnRoute,
    taskFrameToSystemBlock,
    updateTaskFrameAfterTurn,
    upsertTaskFrame,
  } = await import('../../../../lib/context/task-frame.js');

  const prompt = loadPrompt('task-frame-router');
  assert(prompt.includes('continue'), 'prompt documents continue action');
  assert(prompt.includes('fall back to the normal turn pipeline'), 'prompt documents fallback behavior');
  assert(prompt.includes('toolProfile'), 'prompt documents tool profile');

  const logKey = 'owner';
  const first = await classifyTaskFrameTurn({
    logKey,
    userText: 'clone this repo and inspect it',
    availableSkillIds: ['read', 'go-read', 'write', 'apply-patch', 'search'],
    availableSkillSummaries: [],
    llmChat: async () => JSON.stringify({
      action: 'new',
      confidence: 0.91,
      kind: 'repo_work',
      title: 'Clone my-work-list',
      objective: 'Clone and inspect my-work-list',
      projectName: 'My Work List',
      repoUrl: 'https://github.com/bishwashere/my-work-list',
      localPath: '',
      toolProfile: ['read', 'go-read', 'write', 'apply-patch', 'not-enabled'],
      plan: 'Use repo tools to continue the clone/inspection task.',
      reason: 'Concrete repo work request.',
    }),
  });
  assert(first.decision.action === 'new', 'new frame decision preserved');
  assert(first.decision.toolProfile.join(',') === 'read,go-read,write,apply-patch', 'tool profile filtered to enabled skills');
  assert(!shouldUseTaskFrameFastPath(first.decision), 'new frame does not skip the normal first-turn pipeline');

  const frame = upsertTaskFrame(logKey, first.decision, first.activeFrame, { userText: 'clone this repo and inspect it' });
  assert(frame && frame.status === 'active', 'frame stored as active');
  assert(getActiveTaskFrame(logKey)?.projectName === 'My Work List', 'active frame can be loaded');

  const cont = await classifyTaskFrameTurn({
    logKey,
    userText: 'what is inside it?',
    availableSkillIds: ['read', 'go-read', 'write', 'apply-patch', 'search'],
    availableSkillSummaries: [],
    llmChat: async () => JSON.stringify({
      action: 'continue',
      confidence: 0.89,
      kind: 'repo_work',
      title: 'Clone my-work-list',
      objective: 'Inspect my-work-list',
      projectName: 'My Work List',
      repoUrl: '',
      localPath: '',
      toolProfile: ['read', 'go-read'],
      plan: 'Inspect the existing active repo frame.',
      reason: 'Short follow-up refers to the active repo frame.',
    }),
  });
  assert(cont.activeFrame?.id === frame.id, 'continuation sees active frame');
  assert(shouldUseTaskFrameFastPath(cont.decision), 'confident continuation can use fast path');

  const route = taskFrameDecisionToTurnRoute(cont.decision, frame);
  assert(route.mode === 'code', 'repo frame routes as code');
  assert(route.skills.includes('apply-patch'), 'route uses stored frame tools');
  assert(taskFrameToSystemBlock(frame, cont.decision).includes('Active Task Frame'), 'system block is generated');

  const updated = updateTaskFrameAfterTurn(logKey, {
    userText: 'done?',
    assistantText: 'Not done yet.',
    skillsCalled: ['go-read'],
  });
  assert(updated.lastSkillsCalled.includes('go-read'), 'turn update records skills');

  const closed = clearTaskFrame(logKey, { reason: 'user exited' });
  assert(closed.status === 'closed', 'frame closes');
  assert(getActiveTaskFrame(logKey) === null, 'closed frame is not active');

  console.log('task-frame tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
