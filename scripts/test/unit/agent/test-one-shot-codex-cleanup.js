#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..', '..', '..');
const TIMEOUT_MS = 15_000;

const ENTRYPOINTS = [
  { file: 'cron/run-job.js', input: '{}\n' },
  { file: 'cron/run-tide.js', input: '{}\n' },
  { file: 'cron/run-tide-nudge.js', input: '{}\n' },
  { file: 'scripts/chat-dashboard.js', input: '{}\n' },
];

function runEntrypoint(entry, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, entry.file)], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${entry.file} did not exit after one-shot cleanup`));
    }, TIMEOUT_MS);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(entry.input, 'utf8');
  });
}

for (const entry of ENTRYPOINTS) {
  const source = readFileSync(join(ROOT, entry.file), 'utf8');
  assert.match(
    source,
    /import\s*\{\s*closeCodexAppServerClient\s*\}\s*from\s*['"]\.\.\/lib\/llm\/codex-app-server\.js['"]/,
    `${entry.file} must import the shared Codex cleanup`,
  );
  assert.match(
    source,
    /\.finally\s*\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?await closeCodexAppServerClient\(\)/,
    `${entry.file} must await Codex cleanup in a promise finalizer`,
  );
  assert.doesNotMatch(
    source,
    /process\.exit\s*\(\s*1\s*\)/,
    `${entry.file} must not bypass async cleanup with process.exit(1)`,
  );
}

const stateDir = mkdtempSync(join(tmpdir(), 'pasture-one-shot-cleanup-'));
for (const entry of ENTRYPOINTS) {
  const result = await runEntrypoint(entry, stateDir);
  assert.equal(result.code, 1, `${entry.file} should preserve its invalid-input exit code`);
  assert.equal(result.signal, null, `${entry.file} should exit normally after cleanup`);
}

console.log('One-shot Codex cleanup tests passed.');
