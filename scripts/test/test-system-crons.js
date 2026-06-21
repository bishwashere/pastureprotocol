#!/usr/bin/env node
/**
 * Unit tests for system crons = OS crontab -l parsing.
 */
import { parseCrontabLines, readUserCrontab, readSystemCrontabForConfig } from '../../lib/util/system-crons.js';
import {
  extractScriptPath,
  describeScriptContent,
  describeCronCommand,
  enrichCrontabEntries,
} from '../../lib/util/cron-script-describe.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SCRIPT = join(__dirname, 'fixtures/cron-sample.sh');

function check(label, ok, detail = '') {
  const status = ok ? '✅ Pass' : '❌ Fail';
  console.log(`| ${label} | ${detail || '—'} | ${detail || '—'} | ${status} |`);
  if (!ok) process.exitCode = 1;
}

console.log('| Test | Input | Output | Status |');
console.log('|------|-------|--------|--------|');

const sample = `# disabled job
#5 */12 * * * /path/disabled.sh
5 */12 * * * /path/active.sh
*/5 * * * * sh /path/every5.sh
@reboot /path/boot.sh
`;

const parsed = parseCrontabLines(sample);
check('parses active cron', parsed.some((e) => e.enabled && e.expr === '5 */12 * * *'), '/path/active.sh');
check('parses disabled cron', parsed.some((e) => !e.enabled && e.expr === '5 */12 * * *'), 'disabled.sh');
check('parses @reboot', parsed.some((e) => e.expr === '@reboot'), '@reboot');
check('skips pure comments in read filter', readUserCrontab().entries.every((e) => e.kind !== 'comment') || process.platform === 'win32', 'no comment rows');

check('blocks crontab when read skill off', readSystemCrontabForConfig({ skills: { enabled: ['cron'] } }).skillRequired === 'read', 'read');
check('allows crontab when read skill on', readSystemCrontabForConfig({ skills: { enabled: ['read'] } }).skillRequired == null, 'no gate');

check('extractScriptPath sh wrapper', extractScriptPath('sh /tmp/foo.sh arg') === '/tmp/foo.sh', '/tmp/foo.sh');
check('describe fixture header comments', /DB Master Pipeline/i.test(describeScriptContent('#!/bin/bash\n# DB Master Pipeline - runs the database-backed video pipeline once.\n', FIXTURE_SCRIPT) || ''), 'comments');
const enriched = enrichCrontabEntries([{ id: '1', expr: '* * * * *', command: `sh ${FIXTURE_SCRIPT} 1`, enabled: true }]);
check('enrich adds description', !!(enriched[0] && enriched[0].description), enriched[0]?.description || '');
check('describeCronCommand missing file', describeCronCommand('sh /no/such/script.sh').error === 'Script not found.', 'not found');

const live = readUserCrontab();
if (process.platform !== 'win32') {
  check('readUserCrontab ok on unix', live.ok === true, `${live.entries.length} entries`);
  if (live.entries.length > 0) {
    check('live entry has expr', !!live.entries[0].expr, live.entries[0].expr);
    check('live entry has command', !!live.entries[0].command, live.entries[0].command.slice(0, 40));
  }
} else {
  check('win32 reports unavailable', live.ok === false && /Windows/i.test(live.error || ''), live.error || '');
}

if (process.exitCode) {
  console.error('\nSome system-crons tests failed.');
  process.exit(process.exitCode);
}
console.log('\nAll system-crons tests passed.');
