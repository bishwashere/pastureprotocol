#!/usr/bin/env node
/**
 * go-read can run npm package-manager commands. The smoke path avoids network
 * and dependency installs by using npm --version.
 */

import assert from 'assert';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGoRead } from '../../../../lib/agent/executors/go-read.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const workspaceDir = mkdtempSync(join(tmpdir(), 'pasture-go-read-npm-'));

try {
  const version = await executeGoRead({ workspaceDir }, { command: 'npm', argv: ['--version'] });
  check(
    'npm --version returns plain command output',
    /^\d+\.\d+\.\d+/.test(String(version).trim()),
    version
  );

  const missingArgs = await executeGoRead({ workspaceDir }, { command: 'npm', argv: [] });
  const missingArgsJson = parseMaybeJson(missingArgs);
  check(
    'npm with no argv returns an executor error envelope',
    missingArgsJson && typeof missingArgsJson.error === 'string' && missingArgsJson.error.includes('npm requires'),
    missingArgs
  );

  assert.strictEqual(failed, 0);
} finally {
  rmSync(workspaceDir, { recursive: true, force: true });
}

console.log(`\n[go-read-npm] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
