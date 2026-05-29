/**
 * Build label helpers for cowcode update (version + git short SHA).
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { formatVersionLabel, readBuild, BUILD_FILE } from '../../lib/build-info.js';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'cowcode-build-test-'));
const root = join(dir, 'install');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, BUILD_FILE), 'abc1234\n', 'utf8');

assert(readBuild(root) === 'abc1234', 'readBuild from BUILD file');
assert(formatVersionLabel('2.0.0', 'abc1234') === 'v2.0.0 (abc1234)', 'format with version and build');
assert(formatVersionLabel('2.0.0', null) === 'v2.0.0', 'format version only');
assert(formatVersionLabel(null, 'deadbeef') === '(deadbeef)', 'format build only');

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll update-build tests passed.');
