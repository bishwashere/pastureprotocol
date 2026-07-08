#!/usr/bin/env node

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const {
    formatUserFacingReply,
    unwrapFakeSkillMarkup,
    looksLikeFakeSkillMarkup,
    looksLikeInternalToolArtifact,
  } = await import('../../../../lib/agent/user-facing-reply.js');

  const fakeSpeech =
    '<skill action="speech" data="{\\"text\\":\\"Alright Bishwas, here is what is still remaining.\\"}"/>';

  assert(
    looksLikeFakeSkillMarkup(fakeSpeech),
    'fake speech skill tag should be detected as non-human markup',
  );
  assert(
    unwrapFakeSkillMarkup(fakeSpeech) === 'Alright Bishwas, here is what is still remaining.',
    'fake speech skill tag should unwrap to embedded human text',
  );
  assert(
    formatUserFacingReply('[Pasture] ' + fakeSpeech) === 'Alright Bishwas, here is what is still remaining.',
    'formatUserFacingReply should strip prefix and unwrap fake skill markup',
  );

  const fakeToolUses = '{"tool_uses":[{"recipient_name":"functions.apply_patch_apply","parameters":{"path":"server.js"}}]}';
  assert(
    looksLikeInternalToolArtifact(fakeToolUses),
    'tool_uses JSON should be detected as an internal tool artifact',
  );
  assert(
    formatUserFacingReply(fakeToolUses) === '',
    'pure tool_uses JSON should be suppressed',
  );
  assert(
    looksLikeInternalToolArtifact('```json\n' + fakeToolUses + '\n```'),
    'fenced tool_uses JSON should be detected as an internal tool artifact',
  );

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
      input: '{"recipient_name":"functions.go_read_run","parameters":{"command":"sql"}}\nNodes: 2,875',
      expect: 'Nodes: 2,875',
    },
    {
      input: '```json\n{"recipient_name":"functions.write_file","parameters":{"path":"x","content":"y"}}\n```\nDone.',
      expect: 'Done.',
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
