#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const { formatUserFacingReply } = await import('../../lib/agent/user-facing-reply.js');

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

  console.log('\nuser-facing-reply tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
