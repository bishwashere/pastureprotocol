/**
 * Static checks for test page sidebar grouping (dashboard/public/index.html).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '../../dashboard/public/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const checks = [
  {
    name: 'Test sidebar group heading CSS exists',
    ok: html.includes('.test-sidebar-group-title') && html.includes('.test-sidebar-group + .test-sidebar-group'),
  },
  {
    name: 'Overview tile CSS and container exist',
    ok: html.includes('.test-overview-tiles') && html.includes('.test-overview-tile') && html.includes('id="test-overview-tiles"'),
  },
  {
    name: 'Test group order contains 5+ logical sections',
    ok: /var TEST_GROUP_ORDER = \[[\s\S]*'Core Skills'[\s\S]*'Agent-to-Agent'[\s\S]*'User Skills'[\s\S]*'Memory & Workspace'[\s\S]*'Utilities & Infra'/.test(html),
  },
  {
    name: 'Grouping helper maps tests by category',
    ok: /function getTestGroupName\(testId\)/.test(html) && /function groupTestsByCategory\(tests\)/.test(html),
  },
  {
    name: 'Overview tile rendering and filter handlers exist',
    ok: /function renderOverviewTiles\(tests\)/.test(html) && /data-test-group/.test(html) && /activeTestGroup/.test(html),
  },
  {
    name: 'Sidebar renderer prints grouped sections',
    ok: /function renderTestSidebarHtml\(tests\)/.test(html) && html.includes('test-sidebar-group-title'),
  },
  {
    name: 'fetchTests uses grouped sidebar renderer',
    ok: /renderOverviewTiles\(testListCache\);/.test(html) && /refreshTestSidebar\(\);/.test(html),
  },
];

let failed = 0;
for (const c of checks) {
  const status = c.ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${c.name}`);
  if (!c.ok) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll test page UI grouping checks passed.');
