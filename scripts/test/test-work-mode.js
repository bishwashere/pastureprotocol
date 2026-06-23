#!/usr/bin/env node
/**
 * Unit tests for the work-mode classifier.
 *
 * Verifies:
 *  - Storage helpers (chat-session.js): default 'single', set/get round-trip, new
 *    session resets to 'single'.
 *  - md-llm.js: loads prompts from lib/agent/templates/, parses fenced JSON.
 *  - work-mode.js: classifyWorkModeToggle and resolveWorkModeForTurn behave
 *    correctly when the (stubbed) LLM returns enable / disable / no_change /
 *    malformed JSON, and when the LLM throws.
 *
 * The LLM is injected via the `llmChat` test seam — no network calls.
 *
 * Usage: node scripts/test/test-work-mode.js
 *        pnpm run test:work-mode
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-work-mode-test-'));
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ agents: { defaults: { userTimezone: 'UTC', sessionResetHour: 3 } } }, null, 2),
    'utf8'
  );
  process.env.PASTURE_STATE_DIR = stateDir;
}

async function main() {
  setupStateDir();

  const {
    DEFAULT_WORK_MODE,
    getSessionWorkMode,
    setSessionWorkMode,
    startNewSession,
    WORK_MODE_ENABLED_ACK,
    WORK_MODE_DISABLED_ACK,
  } = await import('../../lib/context/chat-session.js');
  const { runMdPrompt, loadPrompt } = await import('../../lib/agent/md-llm.js');
  const {
    classifyWorkModeToggle,
    resolveWorkModeForTurn,
  } = await import('../../lib/agent/work-mode.js');

  // ── 1. Storage helpers ──────────────────────────────────────────────────────
  assert(DEFAULT_WORK_MODE === 'single', 'DEFAULT_WORK_MODE should be "single"');

  const logKey = 'work-mode-test';
  startNewSession(logKey, 'manual');

  assert(getSessionWorkMode(logKey) === 'single', 'fresh session should default to single');

  setSessionWorkMode(logKey, 'multi');
  assert(getSessionWorkMode(logKey) === 'multi', 'work mode should persist after set');

  setSessionWorkMode(logKey, 'single');
  assert(getSessionWorkMode(logKey) === 'single', 'work mode should be settable back to single');

  setSessionWorkMode(logKey, 'multi');
  startNewSession(logKey, 'daily');
  assert(getSessionWorkMode(logKey) === 'single', 'new session must reset work mode to single');

  setSessionWorkMode('', 'multi');
  setSessionWorkMode(null, 'multi');
  assert(getSessionWorkMode('') === 'single', 'empty key reads default');

  // ── 2. md-llm: loadPrompt ──────────────────────────────────────────────────
  const prompt = loadPrompt('work-mode-classifier');
  assert(prompt.length > 100, 'work-mode-classifier MD should be non-trivial');
  assert(/single/i.test(prompt) && /multi/i.test(prompt), 'MD must define both modes');

  // ── 3. md-llm: runMdPrompt strips code fences and parses JSON ──────────────
  const fencedReply = '```json\n{ "toggle": "enable", "reason": "fenced" }\n```';
  const parsed = await runMdPrompt({
    promptName: 'work-mode-classifier',
    user: { currentMode: 'single', userText: 'work mode on' },
    llmChat: async () => fencedReply,
  });
  assert(parsed && parsed.toggle === 'enable', 'fenced JSON should parse to enable');

  // ── 4. md-llm: malformed JSON returns null ─────────────────────────────────
  const bad = await runMdPrompt({
    promptName: 'work-mode-classifier',
    user: { currentMode: 'single', userText: 'whatever' },
    llmChat: async () => 'not json',
  });
  assert(bad === null, 'malformed LLM output should return null');

  // ── 5. md-llm: missing prompt returns null ─────────────────────────────────
  const notFound = await runMdPrompt({
    promptName: 'this-prompt-does-not-exist',
    user: { x: 1 },
    llmChat: async () => '{}',
  });
  assert(notFound === null, 'unknown prompt name should return null');

  // ── 6. classifyWorkModeToggle: each branch ─────────────────────────────────
  const enableRes = await classifyWorkModeToggle({
    userText: 'Hey, work mode on please',
    currentMode: 'single',
    llmChat: async () => '{"toggle":"enable","reason":"explicit ask"}',
  });
  assert(enableRes && enableRes.toggle === 'enable', 'classifier should pass through enable');

  const disableRes = await classifyWorkModeToggle({
    userText: "We're done, back to chat",
    currentMode: 'multi',
    llmChat: async () => '{"toggle":"disable","reason":"asked to leave"}',
  });
  assert(disableRes && disableRes.toggle === 'disable', 'classifier should pass through disable');

  const noChangeRes = await classifyWorkModeToggle({
    userText: 'this code does not work',
    currentMode: 'single',
    llmChat: async () => '{"toggle":"no_change","reason":"unrelated mention"}',
  });
  assert(noChangeRes && noChangeRes.toggle === 'no_change', 'unrelated text → no_change');

  // ── 7. classifyWorkModeToggle: invalid toggle coerces to no_change ─────────
  const invalidToggle = await classifyWorkModeToggle({
    userText: 'whatever',
    currentMode: 'single',
    llmChat: async () => '{"toggle":"banana","reason":"weird"}',
  });
  assert(invalidToggle && invalidToggle.toggle === 'no_change', 'invalid toggle coerces to no_change');

  // ── 8. classifyWorkModeToggle: LLM throw → null ────────────────────────────
  const thrown = await classifyWorkModeToggle({
    userText: 'work mode on',
    currentMode: 'single',
    llmChat: async () => { throw new Error('LLM down'); },
  });
  assert(thrown === null, 'LLM throw → null (caller keeps current mode)');

  // ── 9. resolveWorkModeForTurn: single → multi (toggled = true, ack present)
  const resolveKey = 'resolve-test';
  startNewSession(resolveKey, 'manual');
  const r1 = await resolveWorkModeForTurn({
    userText: 'turn on work mode',
    logKey: resolveKey,
    llmChat: async () => '{"toggle":"enable","reason":"asked"}',
  });
  assert(r1.modeBefore === 'single' && r1.modeAfter === 'multi', 'enable should flip single→multi');
  assert(r1.toggled === true, 'toggled flag should be true');
  assert(r1.ack === WORK_MODE_ENABLED_ACK, 'ack should be the enabled ack');
  assert(getSessionWorkMode(resolveKey) === 'multi', 'storage should be persisted');

  // ── 10. resolveWorkModeForTurn: idempotent (multi + enable → no toggle) ────
  const r2 = await resolveWorkModeForTurn({
    userText: 'work mode on (again)',
    logKey: resolveKey,
    llmChat: async () => '{"toggle":"enable","reason":"already on"}',
  });
  assert(r2.modeBefore === 'multi' && r2.modeAfter === 'multi', 'mode unchanged when already multi');
  assert(r2.toggled === false, 'toggled flag should be false (idempotent)');
  assert(r2.ack === null, 'no ack when no change');

  // ── 11. resolveWorkModeForTurn: multi → single (disable) ───────────────────
  const r3 = await resolveWorkModeForTurn({
    userText: 'back to single agent please',
    logKey: resolveKey,
    llmChat: async () => '{"toggle":"disable","reason":"asked"}',
  });
  assert(r3.modeAfter === 'single' && r3.toggled === true, 'disable should flip multi→single');
  assert(r3.ack === WORK_MODE_DISABLED_ACK, 'ack should be the disabled ack');

  // ── 12. resolveWorkModeForTurn: no_change keeps mode ───────────────────────
  const r4 = await resolveWorkModeForTurn({
    userText: 'what time is it?',
    logKey: resolveKey,
    llmChat: async () => '{"toggle":"no_change","reason":"asking the time"}',
  });
  assert(r4.modeBefore === 'single' && r4.modeAfter === 'single', 'no_change keeps mode');
  assert(r4.toggled === false && r4.ack === null, 'no_change → no ack');

  // ── 13. resolveWorkModeForTurn: empty userText short-circuits ──────────────
  const r5 = await resolveWorkModeForTurn({
    userText: '',
    logKey: resolveKey,
    llmChat: async () => { throw new Error('should not be called'); },
  });
  assert(r5.toggled === false && r5.ack === null, 'empty input is a no-op');

  console.log('Work-mode test passed.');
}

main().catch((err) => {
  console.error('Work-mode test failed:', err.message);
  process.exit(1);
});
