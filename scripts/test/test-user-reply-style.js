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
    const {
      buildUserReplyStyleBlock,
      appendUserFacingPrompt,
      USER_REPLY_STYLE_LINES,
    } = await import('../../lib/user-reply-style.js');
    const { buildOneOnOneSystemPrompt } = await import('../../lib/system-prompt.js');

    assert(USER_REPLY_STYLE_LINES.length >= 4, 'style lines defined');
    const block = buildUserReplyStyleBlock();
    assert(block.includes('coherent narrative'), 'coherent narrative rule');

    const once = appendUserFacingPrompt('base');
    const twice = appendUserFacingPrompt(once);
    assert(once.includes('Replying to the user'), 'appended once');
    assert(once === twice, 'idempotent append');

    const soul = buildOneOnOneSystemPrompt(stateDir);
    assert(!soul.includes('Replying to the user'), 'not in soul/system-prompt base');

    console.log('user-reply-style tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
