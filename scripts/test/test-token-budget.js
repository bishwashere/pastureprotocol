#!/usr/bin/env node
/**
 * Audit finding #21: turn-level char budget across `messages`. The helper
 * functions `messagesCharCount` and `enforceMessagesBudget` are exported
 * from agent.js so they can be tested directly without standing up a real
 * tool-loop.
 */

import {
  messagesCharCount,
  enforceMessagesBudget,
  TOOL_LOOP_LIMITS,
} from '../../lib/agent/agent.js';

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

check('TOOL_LOOP_LIMITS exposes MESSAGES_CHAR_BUDGET', typeof TOOL_LOOP_LIMITS.MESSAGES_CHAR_BUDGET === 'number');
check('default budget is 200_000', TOOL_LOOP_LIMITS.MESSAGES_CHAR_BUDGET === 200_000);

// messagesCharCount
const msgs = [
  { role: 'system', content: 'aaa' },          // 3
  { role: 'user', content: 'bbbbbb' },          // 6
  { role: 'assistant', content: null, tool_calls: [{ function: { name: 'x', arguments: 'cccc' } }] }, // 4
  { role: 'tool', content: 'dd' },              // 2
];
check('messagesCharCount sums content + tool_calls.arguments', messagesCharCount(msgs) === 15, `got ${messagesCharCount(msgs)}`);
check('messagesCharCount returns 0 for empty / missing', messagesCharCount([]) === 0 && messagesCharCount(null) === 0);

// enforceMessagesBudget: should not touch when under budget
const small = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a' },
  { role: 'tool', content: 'tiny' },
  { role: 'user', content: 'follow' },
  { role: 'assistant', content: 'reply' },
];
const before = messagesCharCount(small);
const dropped = enforceMessagesBudget(small, 1000);
check('under-budget pass: nothing dropped', dropped === 0 && messagesCharCount(small) === before);

// enforceMessagesBudget: should drop oldest tool message when over budget
const longTool = 'X'.repeat(2000);
const big = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1', tool_calls: [{ function: { name: 't', arguments: '{}' } }] },
  { role: 'tool', content: longTool },         // ← oldest, eligible
  { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'q2' },
  { role: 'assistant', content: 'a3', tool_calls: [{ function: { name: 't', arguments: '{}' } }] },
  { role: 'tool', content: 'recent' },          // ← inside last-4 window, NOT eligible
  { role: 'assistant', content: 'a4' },
];
const beforeBig = messagesCharCount(big);
const droppedBig = enforceMessagesBudget(big, 1500);
check('over-budget: at least one tool message truncated', droppedBig >= 1, `dropped=${droppedBig}`);
check(
  'over-budget: oldest tool message replaced with placeholder',
  big[3].role === 'tool' && big[3].content.startsWith('[earlier tool output truncated'),
  big[3].content.slice(0, 60)
);
check(
  'over-budget: recent tool message preserved (last-4 window)',
  big[7].role === 'tool' && big[7].content === 'recent'
);
check(
  'over-budget: system message untouched',
  big[0].role === 'system' && big[0].content === 'sys'
);
check(
  'over-budget: shrank to under budget (or as close as safe)',
  messagesCharCount(big) < beforeBig
);

// Hard safety: never loop forever even if everything is small / can't be truncated
const tinyMsgs = [
  { role: 'system', content: 'sys' },
  { role: 'tool', content: 'shorty' },          // < 200 chars => not eligible
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a' },
  { role: 'user', content: 'q' },
  { role: 'assistant', content: 'a' },
];
const safeDrop = enforceMessagesBudget(tinyMsgs, 1);
check('safety: returns when nothing eligible to truncate', safeDrop === 0);

console.log(`\n[token-budget] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
