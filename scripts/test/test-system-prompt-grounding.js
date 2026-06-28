#!/usr/bin/env node
/**
 * Verify the runtime grounding block is present in both the main one-on-one
 * system prompt AND the cron executor system prompt.
 *
 * Why: in production logs the local LLM produced confident-but-wrong replies
 * like "I can't reach localhost from here, the browser tool can't make
 * requests to local addresses from this environment". The daemon literally
 * runs on the user's machine — localhost is reachable. The grounding block
 * tells the model that, instructs it to prefer http_get for plain URLs, and
 * grounds Pasture/CowCode self-inspection in ~/.pasture.
 *
 * This is a unit-level prompt contract test. If the wording is removed or
 * changes such that "localhost" / "http_get" / "daemon" / "~/.pasture" no
 * longer appear, the regression slips back in. So we pin the exact phrases.
 */

import { buildOneOnOneSystemPrompt, FINAL_REPLY_POLICY_BLOCK, RUNTIME_GROUNDING_BLOCK } from '../../lib/agent/system-prompt.js';
import { buildCronSystemPrompt } from '../../cron/run-job.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

const REQUIRED_PHRASES = [
  'localhost',
  '127.0.0.1',
  'daemon',
  'http_get',
  'browse',
];

const CHAT_SELF_INSPECTION_PHRASES = [
  '~/.pasture',
  'check your code',
];

// 1. RUNTIME_GROUNDING_BLOCK contains the required phrases
for (const phrase of [...REQUIRED_PHRASES, ...CHAT_SELF_INSPECTION_PHRASES]) {
  check(
    `RUNTIME_GROUNDING_BLOCK contains "${phrase}"`,
    RUNTIME_GROUNDING_BLOCK.toLowerCase().includes(phrase.toLowerCase()),
    `block: ${RUNTIME_GROUNDING_BLOCK.slice(0, 200)}...`
  );
}

// 2. RUNTIME_GROUNDING_BLOCK explicitly forbids the bad phrasing
check(
  'grounding explicitly tells the model not to refuse localhost',
  /never.*can.*t reach localhost|never tell.*localhost/i.test(RUNTIME_GROUNDING_BLOCK),
  RUNTIME_GROUNDING_BLOCK,
);

// 3. Main one-on-one system prompt embeds the grounding
{
  const prompt = buildOneOnOneSystemPrompt();
  for (const phrase of [...REQUIRED_PHRASES, ...CHAT_SELF_INSPECTION_PHRASES]) {
    check(
      `buildOneOnOneSystemPrompt() contains "${phrase}"`,
      prompt.toLowerCase().includes(phrase.toLowerCase()),
    );
  }
  check(
    'buildOneOnOneSystemPrompt() includes the full grounding block verbatim',
    prompt.includes(RUNTIME_GROUNDING_BLOCK.trim()),
  );
}

// 4. Cron system prompt also grounds the model
{
  const cronPrompt = buildCronSystemPrompt();
  for (const phrase of [...REQUIRED_PHRASES, 'cron executor']) {
    check(
      `buildCronSystemPrompt() contains "${phrase}"`,
      cronPrompt.toLowerCase().includes(phrase.toLowerCase()),
    );
  }
  check(
    'cron prompt advertises the http skill in run_skill list',
    /run_skill[^.]*http/i.test(cronPrompt),
    cronPrompt,
  );
}

// 5. Shared final reply policy is injected independent of mutable SOUL.md files
{
  const prompt = buildOneOnOneSystemPrompt();
  for (const phrase of ['If the user asked for a count', 'Do not include database paths', 'Use tool results as private evidence']) {
    check(
      `FINAL_REPLY_POLICY_BLOCK contains "${phrase}"`,
      FINAL_REPLY_POLICY_BLOCK.includes(phrase),
      FINAL_REPLY_POLICY_BLOCK,
    );
    check(
      `buildOneOnOneSystemPrompt() contains final reply policy phrase "${phrase}"`,
      prompt.includes(phrase),
    );
  }
}

console.log(`\n[system-prompt-grounding] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
