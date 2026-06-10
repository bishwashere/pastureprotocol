#!/usr/bin/env node
/**
 * Unit tests for conversation-context helpers (history in classifiers/probes).
 */

import {
  formatHistoryForClassifier,
  resolveSharedTurnHistory,
  buildPairHistoryContextBlock,
} from '../../lib/conversation-context.js';

const HISTORY = [
  { role: 'user', content: 'Can we rename marketer to something lady name?' },
  { role: 'assistant', content: 'Here are options: 1) Maya 2) Chloe. Tell me your preference.' },
  { role: 'user', content: 'Chloe' },
  { role: 'assistant', content: 'Got it — Chloe. Want me to update the config?' },
];

const USER_CHANNEL_HISTORY = [
  { role: 'user', content: 'ok prepare one such article' },
  {
    role: 'assistant',
    content: 'Title: Stop Writing AI News Recaps. Write This Instead\n\nIf your content calendar is full of "new AI model launched" posts, you are doing free PR for other companies.',
  },
];

const PAIR_HISTORY = [
  { role: 'user', content: 'what are the main blog post from nextpostai?' },
  { role: 'assistant', content: 'Main blog posts are under /ideas.' },
];

function testFormatHistory() {
  const formatted = formatHistoryForClassifier(HISTORY, 2);
  if (!formatted.includes('Chloe')) throw new Error('history missing recent turns');
  if (!formatted.includes('Turn 1')) throw new Error('history missing turn labels');
}

function testResolveSharedTurnHistory() {
  const shared = resolveSharedTurnHistory(USER_CHANNEL_HISTORY, PAIR_HISTORY);
  if (shared !== USER_CHANNEL_HISTORY) throw new Error('expected user-channel history when shared is present');
  const fallback = resolveSharedTurnHistory([], PAIR_HISTORY);
  if (fallback !== PAIR_HISTORY) throw new Error('expected pair history fallback');
  if (resolveSharedTurnHistory(null, null).length !== 0) throw new Error('expected empty when no history');
}

function testPairHistoryIsAdditive() {
  const block = buildPairHistoryContextBlock(PAIR_HISTORY, 'main');
  if (!block.includes('Prior agent-to-agent exchanges with main')) {
    throw new Error('pair block missing header');
  }
  if (!block.includes('in addition to')) throw new Error('pair block should say it is additive');
  if (buildPairHistoryContextBlock([], 'main')) throw new Error('empty pair should produce no block');
}

async function main() {
  console.log('Conversation context helpers\n');
  const rows = [];
  let failed = 0;

  for (const [label, fn] of [
    ['formatHistoryForClassifier', testFormatHistory],
    ['resolveSharedTurnHistory', testResolveSharedTurnHistory],
    ['buildPairHistoryContextBlock', testPairHistoryIsAdditive],
  ]) {
    process.stdout.write(`  ${label} … `);
    try {
      fn();
      console.log('✅');
      rows.push({ test: label, result: '✅ Pass' });
    } catch (err) {
      console.log(`❌  ${err.message}`);
      rows.push({ test: label, result: '❌ Fail', detail: err.message });
      failed++;
    }
  }

  console.log('\n| Test | Result |');
  console.log('| --- | --- |');
  for (const r of rows) {
    console.log(`| \`${r.test}\` | ${r.result}${r.detail ? ' — ' + r.detail : ''} |`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
