#!/usr/bin/env node
/**
 * Static checks: dashboard boots home status + mission control even if late binds fail.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '../../dashboard/public/index.html');
const serverPath = path.join(__dirname, '../../dashboard/server.js');
const publicDir = path.dirname(htmlPath);
const pagesDir = path.join(publicDir, 'pages');
const pageFragments = fs.existsSync(pagesDir)
  ? fs.readdirSync(pagesDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => fs.readFileSync(path.join(pagesDir, name), 'utf8'))
    .join('\n')
  : '';
const html = fs.readFileSync(htmlPath, 'utf8') + '\n' + pageFragments;
const serverJs = fs.readFileSync(serverPath, 'utf8');

function mainScriptBlock() {
  const start = html.indexOf('<script>', html.indexOf('completed-tasks-display'));
  const end = html.lastIndexOf('</script>');
  return html.slice(start + 8, end);
}

const script = mainScriptBlock();
const fetchStatusIdx = script.indexOf('async function fetchStatus()');
const dashboardBootIdx = script.indexOf('function dashboardBoot()');
const dashboardBootCallIdx = script.indexOf('dashboardBoot();');
const routeFnIdx = script.indexOf('function dashboardRouteFromHash()');
const routeCallIdx = script.indexOf('dashboardRouteFromHash();');
const endTail = script.slice(Math.floor(script.length * 0.85));

const checks = [
  {
    name: 'wireClick and wireEl helpers exist',
    ok: script.includes('function wireClick(') && script.includes('function wireEl('),
  },
  {
    name: 'mc2PendingSnapshot initialized with team snapshots',
    ok: /var teamGoalsSnapshot[\s\S]{0,200}var mc2PendingSnapshot = \{ pending: \[\]/.test(script),
  },
  {
    name: 'dashboardBoot runs soon after fetchStatus definition',
    ok: fetchStatusIdx >= 0 && dashboardBootIdx > fetchStatusIdx
      && dashboardBootCallIdx > dashboardBootIdx
      && dashboardBootCallIdx - fetchStatusIdx < 8000,
  },
  {
    name: 'initial route runs early (not only at end of script)',
    ok: routeFnIdx >= 0 && routeCallIdx > routeFnIdx
      && routeCallIdx < script.length * 0.55,
  },
  {
    name: 'home setPage refreshes status and identity tiles',
    ok: /if \(name === 'home'\)[\s\S]*fetchStatus\(\)[\s\S]*fetchChatAgents\(\)[\s\S]*renderHomeIdentityTiles/.test(script),
  },
  {
    name: 'renderMissionControl is fault-tolerant',
    ok: script.includes('function renderMissionControl()') &&
      /function renderMissionControl\(\)[\s\S]*try \{[\s\S]*catch \(err\)/.test(script),
  },
  {
    name: 'mc2PendingItems guards missing snapshot',
    ok: script.includes('mc2PendingSnapshot || { pending: [], updatedAt: 0 }'),
  },
  {
    name: 'skills-save uses wireEl not bare addEventListener',
    ok: script.includes("wireEl('skills-save', 'click'") &&
      !script.includes("document.getElementById('skills-save').addEventListener"),
  },
  {
    name: 'late modal binds use wireClick and try/catch',
    ok: script.includes("wireClick('agent-create-modal-cancel'") &&
      script.includes('[dashboard] modal/chat bind failed'),
  },
  {
    name: 'fetchStatus poll not re-registered at end of script',
    ok: !endTail.includes('setInterval(fetchStatus') && !endTail.match(/\n\s*fetchStatus\(\);\s*\n/),
  },
  {
    name: 'project-workflow pending API on dashboard server',
    ok: serverJs.includes('/api/project-workflow/pending') &&
      serverJs.includes('approvePendingProposal'),
  },
  {
    name: 'home page has status overview element ids',
    ok: html.includes('id="chat-status-text"') &&
      html.includes('id="chat-overview-uptime"') &&
      html.includes('id="home-identity-tiles"'),
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
console.log('\nAll dashboard boot checks passed.');
