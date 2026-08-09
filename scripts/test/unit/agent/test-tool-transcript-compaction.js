#!/usr/bin/env node

import assert from 'assert';
import { compactCheckpointedToolTranscript } from '../../../../lib/agent/tool-transcript-compaction.js';

const pinnedWorklog = { role: 'user', content: 'durable aggregate fact' };
const messages = [
  { role: 'system', content: 'policy' },
  pinnedWorklog,
  { role: 'user', content: 'inspect every project' },
];
for (let index = 0; index < 20; index++) {
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  messages.push({ role: 'tool', tool_call_id: `call-${index}`, content: `large result ${index}` });
}

const outcome = compactCheckpointedToolTranscript(messages, { keepRounds: 3 });
assert.strictEqual(outcome.removedRounds, 17, 'all but the recent tool-round tail is compacted');
assert.strictEqual(outcome.removedMessages, 34, 'assistant and matching tool messages are removed together');
assert(messages.includes(pinnedWorklog), 'runtime worklog context remains pinned');
assert(messages.some((message) => message.content === 'inspect every project'), 'the user request remains pinned');
assert.strictEqual(messages.filter((message) => message.role === 'assistant').length, 3, 'recent assistant calls remain');
assert.strictEqual(messages.filter((message) => message.role === 'tool').length, 3, 'recent tool results remain');
assert(messages.some((message) => message.tool_call_id === 'call-19'), 'newest evidence remains in the live transcript');
assert(!messages.some((message) => message.tool_call_id === 'call-0'), 'old checkpointed evidence leaves live context');

const docMessages = [
  { role: 'assistant', tool_calls: [{ id: 'doc-old', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'doc-old', content: 'result\n\n---\nFull skill doc for read:\n# Read' },
  { role: 'assistant', tool_calls: [{ id: 'doc-new', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'doc-new', content: 'new result' },
];
const docOutcome = compactCheckpointedToolTranscript(docMessages, { keepRounds: 1 });
assert(docOutcome.removedToolMessages.some((message) => message.tool_call_id === 'doc-old'),
  'compaction reports exact removed tool-message objects for trusted skill-doc bookkeeping');

const reusedIds = [
  { role: 'user', content: 'pinned request' },
  { role: 'assistant', tool_calls: [{ id: 'reused', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'reused', content: 'old result' },
  { role: 'assistant', tool_calls: [{ id: 'reused', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'reused', content: 'new result' },
];
const reusedOutcome = compactCheckpointedToolTranscript(reusedIds, { keepRounds: 1 });
assert.strictEqual(reusedOutcome.removedRounds, 1, 'old batch with a reused id is compacted');
assert(reusedIds.some((message) => message.content === 'new result'), 'a later result with the same id remains');
assert(!reusedIds.some((message) => message.content === 'old result'), 'only the old matching occurrence is removed');

const incompleteBatch = [
  { role: 'user', content: 'pinned request' },
  { role: 'assistant', tool_calls: [{ id: 'missing', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'assistant', tool_calls: [{ id: 'complete', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'complete', content: 'complete result' },
];
const incompleteOutcome = compactCheckpointedToolTranscript(incompleteBatch, { keepRounds: 0 });
assert.strictEqual(incompleteOutcome.removedRounds, 1, 'only protocol-complete batches are compacted');
assert(incompleteBatch.some((message) => message?.tool_calls?.[0]?.id === 'missing'),
  'an unmatched assistant tool call is retained');

console.log('tool transcript compaction tests passed');
