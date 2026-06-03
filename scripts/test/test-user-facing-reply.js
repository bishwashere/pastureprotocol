#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { formatUserFacingReply, looksLikeToolAuditReply } = await import('../../lib/user-facing-reply.js');

  const cases = [
    {
      input: '[Pasture] developer replied: [Pasture] You are working on nextpostai.',
      expect: 'You are working on nextpostai.',
    },
    {
      input: '[Pasture] Alex replied: Hello there.',
      expect: 'Hello there.',
    },
    {
      input: 'developer replied: Plain body.',
      expect: 'Plain body.',
    },
    {
      input: '[Pasture] Hi Bishwas.',
      expect: 'Hi Bishwas.',
    },
    {
      input: 'No tags here.',
      expect: 'No tags here.',
    },
  ];

  console.log('| Input | Output | Status |');
  console.log('| --- | --- | --- |');
  for (const c of cases) {
    const out = formatUserFacingReply(c.input);
    const ok = out === c.expect;
    console.log(`| ${c.input.slice(0, 40)}… | ${out.slice(0, 40)} | ${ok ? '✅ Pass' : '❌ Fail'} |`);
    assert(ok, `expected "${c.expect}" got "${out}"`);
  }
  const auditSample =
    'This project is nextpostai.\n\nWhat I found using the required tools\n\ngo-read\nNo repo here.\n\nread\nMEMORY.md empty.\n\nmemory\nFound refs on server1.\n\nSo: product is X.';
  assert(looksLikeToolAuditReply(auditSample), 'detects tool audit');
  assert(!looksLikeToolAuditReply('Nextpostai is an AI marketing tool for social content.'), 'plain answer ok');

  console.log('\nuser-facing-reply tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
