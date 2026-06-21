#!/usr/bin/env node
/**
 * Unit tests for system crons = OS crontab -l parsing.
 */
import { parseCrontabLines, readUserCrontab, readSystemCrontabForConfig } from '../../lib/util/system-crons.js';
import {
  extractScriptPath,
  describeScriptContent,
  extractPurposeFromScript,
  describeCronCommand,
  enrichCrontabEntries,
} from '../../lib/util/cron-script-describe.js';
import { humanizeCronExpr } from '../../lib/util/cron-expr-humanize.js';
import { deriveCronName, derivePurpose } from '../../lib/util/cron-entry-present.js';
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

check('humanize every minute', humanizeCronExpr('* * * * *') === 'Every minute', humanizeCronExpr('* * * * *'));
check('humanize every 5 minutes', humanizeCronExpr('*/5 * * * *') === 'Every 5 minutes', humanizeCronExpr('*/5 * * * *'));
check('humanize daily times', /5:45 AM.*11:45 AM.*4:45 PM/i.test(humanizeCronExpr('45 5,11,16 * * *')), humanizeCronExpr('45 5,11,16 * * *'));
check('humanize every 12 hours', humanizeCronExpr('5 */12 * * *') === 'Every 12 hours at minute 5', humanizeCronExpr('5 */12 * * *'));

check('rejects /bin/bash as description', !/\/bin\/bash/i.test(describeScriptContent('#!/bin/bash\n', '/tmp/x.sh') || ''), 'empty');

const ytFixture = `#!/bin/bash\n# Cron script for automatic YouTube uploader\n# This script checks Mac Drive paths for new videos and uploads them to YouTube\n# Runs 30 minutes before video generation crons\n`;
check('extract purpose skips meta', /Mac Drive/i.test(extractPurposeFromScript(ytFixture, '/tmp/cron_youtube_uploader.sh') || ''), extractPurposeFromScript(ytFixture, '/tmp/cron_youtube_uploader.sh') || '');

const ytEnriched = enrichCrontabEntries([{
  id: 'yt',
  expr: '45 5,11,16 * * *',
  command: '/Users/me/main-projects/tools/video-workspace/post-video-generator/cron_youtube_uploader.sh',
  enabled: false,
  crontabNote: 'YouTube Uploader Cron Jobs - Runs 30 minutes before video generation',
}])[0];
check('structured name', ytEnriched?.name === 'YouTube Uploader', ytEnriched?.name || '');
check('structured schedule', /5:45 AM/i.test(ytEnriched?.scheduleHuman || ''), ytEnriched?.scheduleHuman || '');
check('no /bin/bash in row', !/\/bin\/bash/i.test(JSON.stringify(ytEnriched || {})), 'clean');

const tracker = enrichCrontabEntries([{
  id: 'sync',
  expr: '* * * * *',
  command: '/Users/me/youtube-tracker/scripts/sync-cron.sh',
  enabled: false,
  crontabNote: 'YouTube Tracker Sync',
}])[0];
check('tracker name from note', tracker?.name === 'YouTube Tracker Sync', tracker?.name || '');
check('tracker schedule human', tracker?.scheduleHuman === 'Every minute', tracker?.scheduleHuman || '');
check('tracker script label', tracker?.scriptLabel === 'sync-cron.sh', tracker?.scriptLabel || '');

const shebangSample = `#!/bin/bash\n# Cron script for automatic YouTube uploader\n# Checks Mac Drive paths for new videos\n`;
check('skips shebang in description', !/\/bin\/bash/i.test(describeScriptContent(shebangSample, '/tmp/x.sh') || ''), describeScriptContent(shebangSample, '/tmp/x.sh') || '');
check('reads script header comments', /YouTube uploader/i.test(describeScriptContent(shebangSample, '/tmp/x.sh') || ''), 'YouTube');

check('deriveCronName strips Cron Jobs suffix', deriveCronName('YouTube Uploader Cron Jobs - Runs daily', null, 'sync-cron.sh') === 'YouTube Uploader', 'YouTube Uploader');
check('derivePurpose skips schedule note', !/30 minutes before/i.test(derivePurpose(null, 'YouTube Uploader - Runs 30 minutes before video generation') || ''), 'no schedule');

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

const enriched = enrichCrontabEntries([{ id: '1', expr: '* * * * *', command: `sh ${FIXTURE_SCRIPT} 1`, enabled: true, crontabNote: 'DB Master Pipeline' }])[0];
check('enrich structured fields', !!(enriched?.name && enriched?.scheduleHuman && enriched?.scriptLabel), enriched?.name || '');
check('enrich purpose from script', /database-backed video pipeline/i.test(enriched?.purpose || ''), enriched?.purpose || '');
check('enrich technical args', (enriched?.technicalDetails || []).some((d) => d.startsWith('Args:')), (enriched?.technicalDetails || []).join(', '));

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
