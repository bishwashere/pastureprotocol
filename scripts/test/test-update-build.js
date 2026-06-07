/**
 * Build label helpers for pasture update (version + git short SHA).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { formatVersionLabel, readBuild, fetchRemoteBuildSync, BUILD_FILE } from '../../lib/build-info.js';

let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('OK:', msg);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'pasture-build-test-'));
const root = join(dir, 'install');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, BUILD_FILE), 'abc1234\n', 'utf8');
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

assert(readBuild(root) === 'abc1234', 'readBuild from BUILD file');
assert(formatVersionLabel('2.0.0', 'abc1234') === 'v2.0.0 (abc1234)', 'format with version and build');
assert(formatVersionLabel('2.0.0', null) === 'v2.0.0', 'format version only');
assert(formatVersionLabel(null, 'deadbeef') === '(deadbeef)', 'format build only');

const remote = fetchRemoteBuildSync('master');
if (remote) {
  assert(/^[0-9a-f]{7}$/i.test(remote), 'fetchRemoteBuildSync returns 7-char sha');
} else {
  console.log('SKIP: fetchRemoteBuildSync (no network or git)');
}

const dashboardShell = readFileSync(join(projectRoot, 'dashboard/public/assets/js/00-loader.js'), 'utf8');
assert(
  dashboardShell.includes('root.outerHTML = pages.map') && dashboardShell.includes("}).join('\\n');"),
  'dashboard fragment loader replaces install/update placeholder'
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll update-build tests passed.');
