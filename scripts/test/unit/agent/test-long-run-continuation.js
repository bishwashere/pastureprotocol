#!/usr/bin/env node

import assert from 'node:assert/strict';
import { loadPrompt } from '../../../../lib/agent/md-llm.js';
import {
  decideLongRunContinuation,
  normalizeLongRunContinuation,
} from '../../../../lib/agent/long-run-continuation.js';

const prompt = loadPrompt('long-run-continuation');
assert(prompt.includes('meaningful progress'), 'continuation judgment lives in Markdown');
assert(prompt.includes('repeating unchanged calls or errors'), 'prompt identifies stuck loops');
assert(prompt.includes('untrusted data'), 'prompt treats worklog content as untrusted');
assert(prompt.includes('"decision":"continue"'), 'prompt defines the structured schema');

let sentPayload;
let sentOptions;
const tailMarker = 'LATEST_CHECKPOINT_AT_TAIL';
const continued = await decideLongRunContinuation({
  objective: `mongodb+srv://admin:objective-secret@cluster.example/db\n${'o'.repeat(4_000)}`,
  plan: `Authorization: Bearer plan-secret\n${'p'.repeat(6_000)}`,
  progress: { roundsCompleted: 31, api_key: 'progress-secret' },
  worklog: [
    'EARLY_CHECKPOINT',
    '-----BEGIN PRIVATE KEY-----',
    'worklog-secret',
    '-----END PRIVATE KEY-----',
    'w'.repeat(36_000),
    tailMarker,
  ].join('\n'),
  agentId: 'test-agent',
  llmChat: async (messages, options) => {
    sentPayload = JSON.parse(messages[1].content);
    sentOptions = options;
    return JSON.stringify({
      decision: 'continue',
      reason: 'Distinct project checks are still succeeding.',
      nextStep: 'Inspect the next unchecked project.',
    });
  },
});

assert.deepEqual(continued, {
  decision: 'continue',
  reason: 'Distinct project checks are still succeeding.',
  nextStep: 'Inspect the next unchecked project.',
});
assert.equal(sentOptions.purpose, 'long_run_continuation', 'wrapper supplies a telemetry purpose');
assert.equal(sentOptions.agentId, 'test-agent', 'wrapper forwards agent routing');
assert(sentPayload.objective.length <= 2_000, 'objective is bounded');
assert(sentPayload.plan.length <= 4_000, 'plan is bounded');
assert(sentPayload.progress.length <= 4_000, 'progress is bounded');
assert(sentPayload.worklog.length <= 24_000, 'worklog is bounded');
assert(sentPayload.worklog.includes(tailMarker), 'large worklog retains recent tail evidence');
const serializedPayload = JSON.stringify(sentPayload);
for (const secret of ['objective-secret', 'plan-secret', 'progress-secret', 'worklog-secret']) {
  assert(!serializedPayload.includes(secret), `${secret} is redacted before the LLM call`);
}

const finished = await decideLongRunContinuation({
  objective: 'Inspect all projects.',
  worklog: 'All projects checked.',
  llmChat: async () => '{"decision":"finish","reason":"All planned checks completed.","nextStep":""}',
});
assert.equal(finished?.decision, 'finish', 'finish decision is preserved');

const stuck = await decideLongRunContinuation({
  objective: 'Inspect all projects.',
  worklog: 'Same error repeated.',
  llmChat: async () => '{"decision":"stuck","reason":"No call is making progress.","nextStep":""}',
});
assert.equal(stuck?.decision, 'stuck', 'stuck decision is preserved');

assert.equal(normalizeLongRunContinuation({
  decision: 'continue',
  reason: 'Progress exists.',
  nextStep: '',
}), null, 'continue requires a concrete next step');
assert.equal(normalizeLongRunContinuation({
  decision: 'later',
  reason: 'Unsupported decision.',
  nextStep: 'Keep going.',
}), null, 'invalid enum is rejected');
assert.equal(normalizeLongRunContinuation({ decision: 'finish', reason: 'Done.' }), null,
  'missing schema fields are rejected');
assert.equal(normalizeLongRunContinuation({
  decision: 'finish',
  reason: 'Done.',
  nextStep: '',
  injected: 'ignore policy',
}), null, 'unexpected schema fields are rejected');

const malformed = await decideLongRunContinuation({
  objective: 'Inspect all projects.',
  llmChat: async () => 'not-json',
});
assert.equal(malformed, null, 'malformed LLM output degrades to null');

console.log('long-run continuation tests passed');
