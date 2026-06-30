/**
 * Unit tests for apply-patch executor (workspace path + hunk).
 * Run: node scripts/test/test-apply-patch.js
 */

import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeApplyPatch } from '../../../../lib/agent/executors/apply-patch.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\napply-patch executor tests\n');

await test('applies patch to workspace/ prefixed path', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-patch-'));
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'target.txt'), 'a\nb\n', 'utf8');
  const result = JSON.parse(
    await executeApplyPatch(
      { workspaceDir },
      { path: 'workspace/target.txt', hunk: ' b\n+c\n' }
    )
  );
  if (result.error) throw new Error(result.error);
  if (!result.applied) throw new Error('not applied');
  const content = readFileSync(join(workspaceDir, 'target.txt'), 'utf8');
  if (content !== 'a\nb\nc\n') throw new Error(`got ${JSON.stringify(content)}`);
});

console.log(`\nPassed: ${passed}, Failed: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
