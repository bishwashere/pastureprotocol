#!/usr/bin/env node

import { loadPrompt } from '../../../../lib/agent/md-llm.js';
import { decideTaskWorklog } from '../../../../lib/agent/task-worklog-decision.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const prompt = loadPrompt('task-worklog-decision');
assert(prompt.includes('broad inventory'), 'long-task judgment lives in Markdown');
assert(prompt.includes('several meaningful tool rounds'), 'prompt covers multi-round tasks');

const longDecision = await decideTaskWorklog({
  userText: 'Inspect every project and combine their statuses.',
  hasTools: true,
  llmChat: async () => '{"needsWorklog":true,"reason":"broad inventory"}',
});
assert(longDecision?.needsWorklog === true, 'structured true decision is preserved');

const shortDecision = await decideTaskWorklog({
  userText: 'Count users once.',
  hasTools: true,
  llmChat: async () => '{"needsWorklog":false,"reason":"one lookup"}',
});
assert(shortDecision?.needsWorklog === false, 'structured false decision is preserved');
assert((await decideTaskWorklog({ userText: 'hello', hasTools: false })).needsWorklog === false,
  'no-tool turns skip the classifier');

console.log('task-worklog decision tests passed');
