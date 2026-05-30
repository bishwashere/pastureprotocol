#!/usr/bin/env node
/**
 * Unit tests for conversation continuation detection (Chloe-after-list regression).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isLikelyContinuationReply,
  shouldSkipToolRetryProbe,
  buildContinuationContextBlock,
  formatHistoryForClassifier,
} from '../../lib/conversation-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const NAME_LIST_ASSISTANT =
  'Yes. Here are good lady-name replacements for marketer:\n\n' +
  '1) Maya\n2) Clara\n3) Ella\n4) Nina\n5) Sophie\n6) Chloe (bright, creative)\n7) Zara\n\n' +
  'Tell me your preference, and I\'ll help you update the config/name everywhere.';

const HISTORY = [
  { role: 'user', content: 'Can we rename marketer to something lady name?' },
  { role: 'assistant', content: NAME_LIST_ASSISTANT },
];

const HISTORY_RENAME = [
  { role: 'user', content: 'Can we rename marketer to Chloe?' },
  { role: 'assistant', content: 'I can rename marketer to Chloe. Want me to update the title in config now?' },
];

const CASES = [
  {
    label: 'Chloe after numbered name list',
    userText: 'Chloe',
    history: HISTORY,
    expectContinuation: true,
    expectSkipProbe: true,
  },
  {
    label: 'Maya pick after list',
    userText: 'Maya',
    history: HISTORY,
    expectContinuation: true,
  },
  {
    label: 'Standalone weather query is not a continuation',
    userText: 'What is the weather in Tokyo today?',
    history: HISTORY,
    expectContinuation: false,
    expectSkipProbe: false,
  },
  {
    label: 'Hi after list is short but not in list',
    userText: 'Hi',
    history: HISTORY,
    expectContinuation: false,
  },
  {
    label: 'Implicit feedback marks continuation',
    userText: 'Chloe',
    history: [],
    implicitFeedback: 'The user chose Chloe from the suggested lady-name replacements.',
    expectContinuation: true,
  },
  {
    label: 'yes after action offer',
    userText: 'yes',
    history: HISTORY_RENAME,
    expectContinuation: true,
    expectSkipProbe: true,
  },
  {
    label: 'do it after action offer',
    userText: 'do it',
    history: HISTORY_RENAME,
    expectContinuation: true,
  },
  {
    label: 'go ahead after action offer',
    userText: 'go ahead',
    history: [
      { role: 'user', content: 'Ask alex to review the API' },
      { role: 'assistant', content: 'I can ask alex via agent-send. Want me to do that now?' },
    ],
    expectContinuation: true,
  },
];

function runCase(tc) {
  const cont = isLikelyContinuationReply(tc.userText, tc.history, tc.implicitFeedback);
  if (cont !== tc.expectContinuation) {
    throw new Error(`isLikelyContinuationReply: expected ${tc.expectContinuation}, got ${cont}`);
  }
  const skip = shouldSkipToolRetryProbe({
    userText: tc.userText,
    historyMessages: tc.history,
    intentPlan: { mode: 'chat', skills: [] },
    implicitFeedback: tc.implicitFeedback,
  });
  const expectSkip = tc.expectSkipProbe ?? tc.expectContinuation;
  if (skip !== expectSkip) {
    throw new Error(`shouldSkipToolRetryProbe: expected ${expectSkip}, got ${skip}`);
  }
  if (tc.expectContinuation) {
    const block = buildContinuationContextBlock(tc.userText, tc.history, tc.implicitFeedback);
    if (!block.includes('Conversation continuation')) {
      throw new Error('buildContinuationContextBlock missing header');
    }
    if (!block.includes('Do NOT web-search')) {
      throw new Error('continuation block should warn against web search');
    }
  }
}

function testFormatHistory() {
  const formatted = formatHistoryForClassifier(HISTORY, 2);
  if (!formatted.includes('rename marketer')) throw new Error('history missing user turn');
  if (!formatted.includes('Chloe')) throw new Error('history missing assistant turn');
}

async function main() {
  console.log('Conversation context tests\n');
  const rows = [];
  let failed = 0;

  try {
    testFormatHistory();
    console.log('  formatHistoryForClassifier … ✅');
    rows.push({ test: 'formatHistoryForClassifier', result: '✅ Pass', detail: 'includes prior turns' });
  } catch (err) {
    console.log(`  formatHistoryForClassifier … ❌  ${err.message}`);
    rows.push({ test: 'formatHistoryForClassifier', result: '❌ Fail', detail: err.message });
    failed++;
  }

  for (const tc of CASES) {
    process.stdout.write(`  ${tc.label} … `);
    try {
      runCase(tc);
      console.log('✅');
      rows.push({ test: tc.label, result: '✅ Pass', detail: 'continuation detection OK' });
    } catch (err) {
      console.log(`❌  ${err.message}`);
      rows.push({ test: tc.label, result: '❌ Fail', detail: err.message });
      failed++;
    }
  }

  console.log('\n| Test | Scenario | Result |');
  console.log('| --- | --- | --- |');
  for (const r of rows) {
    console.log(`| \`${r.test}\` | ${r.detail} | ${r.result} |`);
  }
  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
