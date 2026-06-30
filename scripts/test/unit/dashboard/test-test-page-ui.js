/**
 * Static checks for test page sidebar grouping (dashboard/public/index.html).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../../../../dashboard/public');
const htmlPath = path.join(publicDir, 'index.html');
const dashboardShell = fs.readFileSync(htmlPath, 'utf8');
const assetsJsDir = path.join(publicDir, 'assets/js');
const appJs = fs.readdirSync(assetsJsDir)
  .filter((name) => /^\d{2}-.*\.js$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(assetsJsDir, name), 'utf8'))
  .join('\n');
const loaderJs = fs.readFileSync(path.join(assetsJsDir, '00-loader.js'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(publicDir, 'assets/css/dashboard.css'), 'utf8');
const pageFragments = fs.readdirSync(path.join(publicDir, 'pages'))
  .filter((name) => name.endsWith('.html'))
  .map((name) => fs.readFileSync(path.join(publicDir, 'pages', name), 'utf8'));
const html = [dashboardShell, dashboardCss, appJs, ...pageFragments].join('\n');

const checks = [
  {
    name: 'Dashboard app scripts are syntactically valid',
    ok: (() => {
      try {
        new Function(appJs);
        return true;
      } catch (err) {
        console.error(err.message);
        return false;
      }
    })(),
  },
  {
    name: 'Dashboard page fragment loader inserts fetched pages',
    ok: /id="page-fragments-root"/.test(dashboardShell) &&
      /pages\/'\s*\+\s*page\s*\+\s*'\.html'/.test(loaderJs) &&
      /root\.outerHTML\s*=/.test(loaderJs),
  },
  {
    name: 'Dashboard fragment wrapper does not remain in layout',
    ok: !/#page-fragments-root\s*\{[^}]*display:\s*contents/.test(dashboardCss) && /root\.outerHTML\s*=/.test(loaderJs),
  },
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
