#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-reply-style-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { buildUserReplyStyleBlock, USER_REPLY_STYLE_LINES } = await import('../../lib/user-reply-style.js');
    const { buildOneOnOneSystemPrompt } = await import('../../lib/system-prompt.js');

    assert(USER_REPLY_STYLE_LINES.length >= 4, 'style lines defined');
    const block = buildUserReplyStyleBlock();
    assert(block.includes('coherent narrative'), 'coherent narrative rule');
    assert(block.includes('Sources'), 'sources rule');

    const prompt = buildOneOnOneSystemPrompt(stateDir);
    assert(prompt.includes('Replying to the user'), 'wired into system prompt');

    console.log('user-reply-style tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
