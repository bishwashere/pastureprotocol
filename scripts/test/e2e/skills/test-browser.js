/**
 * Browser/news tests: run E2E through the main chatting interface.
 * Each test sends a user message → intent → LLM + browser tool → reply.
 * Not unit tests: we assert on end-to-end input and output (with AI delay).
 */

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

// Delegate to the E2E script so test:browser and test:browser-e2e share the same flow.
const child = spawn('node', ['scripts/test/e2e/skills/test-browser-e2e.js'], {
  cwd: ROOT,
  env: process.env,
  stdio: 'inherit',
});
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
