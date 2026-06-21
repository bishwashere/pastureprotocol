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

const shebangSample = `#!/bin/bash\n# Cron script for automatic YouTube uploader\n# Checks Mac Drive paths for new videos\n`;
check('skips shebang in description', !/\/bin\/bash/i.test(describeScriptContent(shebangSample, '/tmp/x.sh') || ''), describeScriptContent(shebangSample, '/tmp/x.sh') || '');
check('reads script header comments', /YouTube uploader/i.test(describeScriptContent(shebangSample, '/tmp/x.sh') || ''), 'YouTube');

const parsedNotes = parseCrontabLines('# YouTube Uploader Cron Jobs\n#45 5 * * * /path/uploader.sh\n');
const noteEntry = parsedNotes.find((e) => !e.enabled && e.expr === '45 5 * * *');
check('crontab note on disabled entry', noteEntry?.crontabNote === 'YouTube Uploader Cron Jobs', noteEntry?.crontabNote || '');

const parsed = parseCrontabLines(sample);
check('parses active cron', parsed.some((e) => e.enabled && e.expr === '5 */12 * * *'), '/path/active.sh');
check('parses disabled cron', parsed.some((e) => !e.enabled && e.expr === '5 */12 * * *'), 'disabled.sh');
check('parses @reboot', parsed.some((e) => e.expr === '@reboot'), '@reboot');
check('skips pure comments in read filter', readUserCrontab().entries.every((e) => e.kind !== 'comment') || process.platform === 'win32', 'no comment rows');

check('blocks crontab when read skill off', readSystemCrontabForConfig({ skills: { enabled: ['cron'] } }).skillRequired === 'read', 'read');
check('allows crontab when read skill on', readSystemCrontabForConfig({ skills: { enabled: ['read'] } }).skillRequired == null, 'no gate');

check('extractScriptPath sh wrapper', extractScriptPath('sh /tmp/foo.sh arg') === '/tmp/foo.sh', '/tmp/foo.sh');
check('describe fixture header comments', /DB Master Pipeline/i.test(describeScriptContent('#!/bin/bash\n# DB Master Pipeline - runs the database-backed video pipeline once.\n', FIXTURE_SCRIPT) || ''), 'comments');
check('enrich merges crontab note', (() => {
  const row = enrichCrontabEntries([{ id: '1', expr: '* * * * *', command: `sh ${FIXTURE_SCRIPT} 1`, enabled: false, crontabNote: 'YouTube Uploader Cron Jobs' }])[0];
  return row && /YouTube Uploader/i.test(row.description || '') && /DB Master Pipeline/i.test(row.description || '');
})(), 'merged');

const enriched = enrichCrontabEntries([{ id: '1', expr: '* * * * *', command: `sh ${FIXTURE_SCRIPT} 1`, enabled: true }]);
check('enrich adds description', !!(enriched[0] && enriched[0].description && /DB Master Pipeline/i.test(enriched[0].description)), enriched[0]?.description || '');
check('describeCronCommand missing file', /Script not found/i.test(describeCronCommand('sh /no/such/script.sh').error || ''), 'not found');

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
