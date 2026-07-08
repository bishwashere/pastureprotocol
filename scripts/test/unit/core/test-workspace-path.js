/**
 * Unit tests for workspace path resolution.
 * Run: node scripts/test/test-workspace-path.js
 */

import { isAbsolute, join, resolve } from 'path';
import { resolveWorkspacePath } from '../../../../lib/util/workspace-path.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

const ws = resolve('tmp', 'pasture-ws');

console.log('\nworkspace-path tests\n');

test('strips workspace/ prefix', () => {
  const { resolved } = resolveWorkspacePath(ws, 'workspace/e2e-patch-target.txt');
  if (resolved !== resolve(join(ws, 'e2e-patch-target.txt'))) throw new Error(resolved);
});

test('keeps plain relative path', () => {
  const { resolved } = resolveWorkspacePath(ws, 'notes.md');
  if (resolved !== resolve(join(ws, 'notes.md'))) throw new Error(resolved);
});

test('keeps Windows absolute path absolute on Windows', () => {
  const absolute = 'C:\\Users\\Binit KC\\.pasture\\notes.md';
  const { resolved } = resolveWorkspacePath(ws, absolute);
  const expected = isAbsolute(absolute) ? absolute : join(ws, absolute);
  if (resolved !== expected) throw new Error(resolved);
});

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
