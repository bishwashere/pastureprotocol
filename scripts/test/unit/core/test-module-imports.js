#!/usr/bin/env node
/**
 * Import smoke tests for startup-critical ESM modules.
 *
 * This catches broken named exports before install/update reports success. It
 * is deliberately cheap and side-effect-light: do not import daemon entrypoints
 * here, only modules that are expected to be safe to load.
 */

import assert from 'assert';
import { pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function importRoot(relativePath) {
  const url = pathToFileURL(join(ROOT, relativePath)).href;
  return import(`${url}?module-import-smoke=${Date.now()}`);
}

const auth = await importRoot('lib/llm/auth.js');
assert.strictEqual(
  typeof auth.isCodexManagedChatgptAuth,
  'function',
  'lib/llm/auth.js must export isCodexManagedChatgptAuth for llm.js startup',
);

await importRoot('lib/llm/codex-app-server.js');
await importRoot('lib/llm/codex-provider.js');
await importRoot('llm.js');

console.log('test-module-imports passed');
