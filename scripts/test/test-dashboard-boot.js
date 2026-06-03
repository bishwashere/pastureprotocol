#!/usr/bin/env node
/**
 * Static checks: dashboard boots home status + mission control (split assets layout).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../../dashboard/public');
const htmlPath = path.join(publicDir, 'index.html');
const serverPath = path.join(__dirname, '../../dashboard/server.js');
const assetsJs = path.join(publicDir, 'assets/js');
const appScripts = [
  '01-core-router-status.js',
  '02-crons-skills-agents.js',
  '03-chat-team.js',
  '04-mission-control.js',
  '05-bind-init.js',
  '06-projects.js',
].map((f) => fs.readFileSync(path.join(assetsJs, f), 'utf8')).join('\n');
const loaderJs = fs.readFileSync(path.join(assetsJs, '00-loader.js'), 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const pagesDir = path.join(publicDir, 'pages');
const pageFragments = fs.existsSync(pagesDir)
  ? fs.readdirSync(pagesDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => fs.readFileSync(path.join(pagesDir, name), 'utf8'))
    .join('\n')
  : '';
const fullHtml = html + '\n' + pageFragments;
const serverJs = fs.readFileSync(serverPath, 'utf8');
const script = appScripts;
const core = fs.readFileSync(path.join(assetsJs, '01-core-router-status.js'), 'utf8');
const chat = fs.readFileSync(path.join(assetsJs, '03-chat-team.js'), 'utf8');
const bind = fs.readFileSync(path.join(assetsJs, '05-bind-init.js'), 'utf8');

const checks = [
  {
    name: 'index.html links split CSS and JS assets',
    ok: html.includes('assets/css/dashboard.css') &&
      html.includes('assets/css/team2.css') &&
      html.includes('assets/js/00-loader.js') &&
      html.includes('assets/js/01-core-router-status.js') &&
      !html.includes('<style>'),
  },
  {
    name: 'loader injects nav, modals, and pages',
    ok: loaderJs.includes('assets/partials/nav.html') &&
      loaderJs.includes('assets/partials/modals.html') &&
      loaderJs.includes('pages/') &&
      loaderJs.includes('dashboard-nav-root'),
  },
  {
    name: 'nav partial exists with all main tabs',
    ok: ['home', 'memory', 'crons', 'skills', 'team', 'projects'].every((p) =>
      fs.readFileSync(path.join(publicDir, 'assets/partials/nav.html'), 'utf8').includes('data-page="' + p + '"')),
  },
  {
    name: 'wireClick and wireEl helpers exist',
    ok: script.includes('function wireClick(') && script.includes('function wireEl('),
  },
  {
    name: 'mc2PendingSnapshot initialized with team snapshots',
    ok: /var teamGoalsSnapshot[\s\S]{0,200}var mc2PendingSnapshot = \{ pending: \[\]/.test(core),
  },
  {
    name: 'dashboardBoot runs soon after fetchStatus in core bundle (home data load regression)',
    ok: /async function fetchStatus\(\)[\s\S]*function dashboardBoot\(\)[\s\S]*dashboardBoot\(\)/.test(core) &&
      core.includes('dashboardBoot()') &&
      !chat.includes('dashboardBoot()') &&
      !bind.includes('dashboardBoot()'),
  },
  {
    name: 'index.html loads core router before chat and mission-control bundles',
    ok: (() => {
      const scripts = [...html.matchAll(/assets\/js\/(\d{2}-[^"]+\.js)/g)].map((m) => m[1]);
      const coreIdx = scripts.indexOf('01-core-router-status.js');
      const chatIdx = scripts.indexOf('03-chat-team.js');
      const mcIdx = scripts.indexOf('04-mission-control.js');
      return coreIdx >= 0 && chatIdx > coreIdx && mcIdx > chatIdx;
    })(),
  },
  {
    name: 'home setPage refreshes status and identity tiles',
    ok: /if \(name === 'home'\)[\s\S]*fetchStatus\(\)[\s\S]*fetchChatAgents\(\)[\s\S]*renderHomeIdentityTiles/.test(core),
  },
  {
    name: 'renderMissionControl is fault-tolerant',
    ok: script.includes('function renderMissionControl()') &&
      /function renderMissionControl\(\)[\s\S]*try \{[\s\S]*catch \(err\)/.test(script),
  },
  {
    name: 'skills-save uses wireEl not bare addEventListener',
    ok: script.includes("wireEl('skills-save', 'click'") &&
      !script.includes("document.getElementById('skills-save').addEventListener"),
  },
  {
    name: 'late modal binds use wireClick and try/catch',
    ok: bind.includes("wireClick('agent-create-modal-cancel'") &&
      bind.includes('[dashboard] modal/chat bind failed'),
  },
  {
    name: 'project-workflow pending API on dashboard server',
    ok: serverJs.includes('/api/project-workflow/pending') &&
      serverJs.includes('approvePendingProposal'),
  },
  {
    name: 'home page has status overview element ids',
    ok: fullHtml.includes('id="chat-status-text"') &&
      fullHtml.includes('id="chat-overview-uptime"') &&
      fullHtml.includes('id="home-identity-tiles"'),
  },
  {
    name: 'chat bundle guards mission-control forward refs before script 04 loads (click handler regression)',
    ok: chat.includes("typeof renderMissionControl === 'function'") &&
      chat.includes("typeof mc2SyncTimelineHighlightForScroll === 'function'") &&
      !/function setTeamAgentPanelRange[\s\S]{0,600}renderMissionControl\(\);/.test(chat),
  },
  {
    name: 'home chat toolbar buttons wired in bind-init after all bundles load',
    ok: bind.includes("wireEl('chat-send', 'click'") &&
      bind.includes("wireClick('chat-agent-create-btn'") &&
      bind.includes("wireClick('chat-new-btn'") &&
      bind.includes("wireClick('agent-team-create-btn'"),
  },
  {
    name: 'initial hash route runs from bind-init after all bundles load',
    ok: bind.includes('dashboardRouteFromHash()') &&
      !/dashboardBoot\(\);\s*\n\s*dashboardRouteFromHash\(\)/.test(core),
  },
  {
    name: 'home setPage guards fetchChatAgents until chat bundle loads',
    ok: /if \(name === 'home'\)[\s\S]*typeof fetchChatAgents === 'function'/.test(core),
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
