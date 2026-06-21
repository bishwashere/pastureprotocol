#!/usr/bin/env node
/**
 * Unit tests for system crons = OS crontab -l parsing.
 */
import { parseCrontabLines, readUserCrontab } from '../../lib/util/system-crons.js';

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
