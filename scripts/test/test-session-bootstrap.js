/**
 * Session bootstrap: MEMORY.md + today/yesterday memory/*.md
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSessionBootstrapContext,
  getTodayAndYesterdayDates,
} from '../../lib/session-bootstrap.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cowcode-bootstrap-'));
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(join(workspaceDir, 'memory'), { recursive: true });
  writeFileSync(join(workspaceDir, 'MEMORY.md'), '# Notes\nRemember the API key.', 'utf8');
  const { today, yesterday } = getTodayAndYesterdayDates(new Date('2026-05-28T12:00:00Z'), 'UTC');
  writeFileSync(join(workspaceDir, 'memory', `${today}.md`), `# ${today}\nDid deploy.`, 'utf8');
  writeFileSync(join(workspaceDir, 'memory', `${yesterday}.md`), `# ${yesterday}\nFixed bug.`, 'utf8');
  return { workspaceDir, today, yesterday };
}

async function main() {
  const { workspaceDir, today, yesterday } = setup();
  const { block, sources } = buildSessionBootstrapContext(workspaceDir, {
    now: new Date('2026-05-28T12:00:00Z'),
    tz: 'UTC',
  });
  if (!block.includes('MEMORY.md')) throw new Error('missing MEMORY.md in bootstrap');
  if (!block.includes(`memory/${today}.md`)) throw new Error('missing today md');
  if (!block.includes(`memory/${yesterday}.md`)) throw new Error('missing yesterday md');
  if (!sources.includes('MEMORY.md')) throw new Error('sources missing MEMORY.md');
  console.log('Session bootstrap test passed.', sources.join(', '));
}

main().catch((e) => {
  console.error('Session bootstrap test failed:', e.message);
  process.exit(1);
});
