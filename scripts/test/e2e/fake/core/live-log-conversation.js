#!/usr/bin/env node
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..', '..', '..');
const child = spawn(process.execPath, [
  'scripts/test/e2e/real/core/live-log-conversation.js',
  '--fake',
  ...process.argv.slice(2),
], {
  cwd: root,
  env: { ...process.env, PASTURE_E2E_MODE: 'fake' },
  stdio: 'inherit',
});

child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
