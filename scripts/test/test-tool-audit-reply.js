#!/usr/bin/env node
/**
 * Unit tests for tool-audit reply detection (no LLM).
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { looksLikeToolAuditReply, formatUserFacingReply } = await import('../../lib/user-facing-reply.js');
  const { buildToolAuditRewriteInstruction } = await import('../../lib/user-reply-style.js');

  const userSample =
    'What I found using the required tools\n\ngo-read\nNo code repo.\n\nread\nMEMORY empty.\n\nmemory\nFound server1 repos.';
  assert(looksLikeToolAuditReply(userSample), 'detects audit');
  assert(!looksLikeToolAuditReply('Nextpostai is an AI marketing tool for social posts.'), 'plain ok');
  assert(buildToolAuditRewriteInstruction('what is this about?').includes('Do not name tools'), 'rewrite instruction');

  const rows = [
    { input: 'audit sample', output: 'detected', status: looksLikeToolAuditReply(userSample) },
    { input: 'plain answer', output: 'ok', status: !looksLikeToolAuditReply('Short product summary.') },
  ];

  console.log('| Test | Input | Output | Status |');
  console.log('| --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`| tool-audit | ${r.input} | ${r.output} | ${r.status ? '✅ Pass' : '❌ Fail'} |`);
    assert(r.status, r.input);
  }

  const stripped = formatUserFacingReply('[CowCode] dev replied: ' + userSample);
  assert(looksLikeToolAuditReply(stripped), 'still audit after tag strip');

  console.log('\ntool-audit-reply tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
