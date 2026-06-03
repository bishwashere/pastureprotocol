#!/usr/bin/env node
/**
 * Static checks: dashboard boots home status + mission control (split assets layout).
 * Runtime check: dashboard/server.js starts without parse/runtime crash (regression for async route handlers).
 */
import fs, { mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { tmpdir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const publicDir = path.join(__dirname, '../../dashboard/public');
const htmlPath = path.join(publicDir, 'index.html');
const serverPath = path.join(__dirname, '../../dashboard/server.js');
const assetsJs = path.join(publicDir, 'assets/js');
const mc2JsDir = path.join(assetsJs, 'mc2');
const mc2JsFiles = [
  '04-mc2-shared.js',
  '04-mc2-nav.js',
  '04-mc2-home.js',
  '04-mc2-tasks.js',
  '04-mc2-views.js',
  '04-mc2-chrome.js',
  '04-mc2-core.js',
];
const mc2Js = mc2JsFiles.map((f) => fs.readFileSync(path.join(mc2JsDir, f), 'utf8')).join('\n');
const appScripts = [
  '01-core-router-status.js',
  '02-crons-skills-agents.js',
  '03-chat-team.js',
  ...mc2JsFiles.map((f) => path.join('mc2', f)),
  '04-mission-control.js',
  '05-bind-init.js',
  '06-projects.js',
].map((f) => fs.readFileSync(path.join(assetsJs, f), 'utf8')).join('\n');
const loaderJs = fs.readFileSync(path.join(assetsJs, '00-loader.js'), 'utf8');
const html = fs.readFileSync(htmlPath, 'utf8');
const pagesDir = path.join(publicDir, 'pages');
const mc2PagesDir = path.join(pagesDir, 'mc2');
const mc2ViewsHtml = fs.existsSync(mc2PagesDir)
  ? ['view-home', 'view-tasks', 'view-agents', 'view-context', 'view-goals', 'view-initiatives', 'view-projects', 'view-activity', 'view-stats']
    .map((name) => fs.readFileSync(path.join(mc2PagesDir, name + '.html'), 'utf8'))
    .join('\n')
  : '';
const pageFragments = fs.existsSync(pagesDir)
  ? fs.readdirSync(pagesDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => {
      let fragment = fs.readFileSync(path.join(pagesDir, name), 'utf8');
      if (name === 'team2.html') {
        fragment = fragment.replace('<!-- MC2_VIEWS -->', mc2ViewsHtml);
      }
      return fragment;
    })
    .join('\n')
  : '';
const fullHtml = html + '\n' + pageFragments;
const serverJs = fs.readFileSync(serverPath, 'utf8');
const script = appScripts;
const core = fs.readFileSync(path.join(assetsJs, '01-core-router-status.js'), 'utf8');
const chat = fs.readFileSync(path.join(assetsJs, '03-chat-team.js'), 'utf8');
const missionControlJs = mc2Js + fs.readFileSync(path.join(assetsJs, '04-mission-control.js'), 'utf8');
const bind = fs.readFileSync(path.join(assetsJs, '05-bind-init.js'), 'utf8');
const team2Css = fs.readFileSync(path.join(publicDir, 'assets/css/team2.css'), 'utf8');

const checks = [
  {
    name: 'index.html links split CSS and JS assets',
    ok: html.includes('assets/css/dashboard.css') &&
      html.includes('assets/css/team2.css') &&
      html.includes('assets/js/00-loader.js') &&
      html.includes('assets/js/mc2/04-mc2-core.js') &&
      html.includes('assets/js/01-core-router-status.js') &&
      !html.includes('<style>') &&
      !html.includes('assets/css/mc2/'),
  },
  {
    name: 'loader injects nav, modals, and pages',
    ok: loaderJs.includes('assets/partials/nav.html') &&
      loaderJs.includes('assets/partials/modals.html') &&
      loaderJs.includes('pages/') &&
      loaderJs.includes('pages/mc2/') &&
      loaderJs.includes('MC2_VIEWS') &&
      loaderJs.includes('dashboard-nav-root'),
  },
  {
    name: 'nav partial exists with all main tabs',
    ok: ['home', 'memory', 'crons', 'skills', 'team', 'team2', 'projects'].every((p) =>
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
      const scripts = [...html.matchAll(/assets\/js\/([\w/.-]+\.js)/g)].map((m) => m[1]);
      const coreIdx = scripts.indexOf('01-core-router-status.js');
      const chatIdx = scripts.indexOf('03-chat-team.js');
      const mcSharedIdx = scripts.indexOf('mc2/04-mc2-shared.js');
      const mcCoreIdx = scripts.indexOf('mc2/04-mc2-core.js');
      const bindIdx = scripts.indexOf('05-bind-init.js');
      return coreIdx >= 0 && chatIdx > coreIdx && mcSharedIdx > chatIdx &&
        mcCoreIdx > mcSharedIdx && bindIdx > mcCoreIdx;
    })(),
  },
  {
    name: 'home setPage refreshes status and identity tiles',
    ok: /if \(name === 'home'\)[\s\S]*fetchStatus\(\)[\s\S]*fetchChatAgents\(\)[\s\S]*renderHomeIdentityTiles/.test(core),
  },
  {
    name: 'renderMissionControl is fault-tolerant',
    ok: script.includes('function renderMissionControl()') &&
      script.includes('function mc2RenderHome()') &&
      script.includes('function mc2RenderLiveChrome()') &&
      /function renderMissionControl\(\)[\s\S]*try \{[\s\S]*catch \(err\)/.test(script) &&
      /function renderMissionControl\(\)[\s\S]*mc2ActiveView === 'mission'[\s\S]*mc2RenderHome\(\)/.test(script),
  },
  {
    name: 'MC2 views split into pages/mc2 partials',
    ok: fs.existsSync(path.join(mc2PagesDir, 'view-home.html')) &&
      fs.existsSync(path.join(mc2PagesDir, 'view-tasks.html')) &&
      fullHtml.includes('id="mc2-views-root"') &&
      fullHtml.includes('id="mc2-views-root"') &&
      fullHtml.includes('id="mc2-view-mission"') &&
      !fullHtml.includes('<!-- MC2_VIEWS -->'),
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
    name: 'initiative promote route is async (await promoteInitiativeToSubgoal)',
    ok: /app\.post\('\/api\/initiatives\/:id\/promote',\s*async\s*\(req,\s*res\)\s*=>\s*\{[\s\S]*await promoteInitiativeToSubgoal\(/.test(serverJs),
  },
  {
    name: 'attention needed items are clickable buttons with actions',
    ok: missionControlJs.includes('data-attention-action') &&
      missionControlJs.includes('mc2HandleAttentionClick') &&
      missionControlJs.includes("return '<button'") &&
      missionControlJs.includes('goal-input'),
  },
  {
    name: 'mission kanban uses informative work-state column labels',
    ok: fullHtml.includes('NEEDS ATTENTION') &&
      fullHtml.includes('WORK COMPLETED') &&
      fullHtml.includes('WORK IN PROGRESS') &&
      fullHtml.includes('AUTO DISCOVERIES') &&
      fullHtml.includes('id="mc2-col-attention"') &&
      fullHtml.includes('id="mc2-col-completed"') &&
      fullHtml.includes('id="mc2-col-progress"') &&
      fullHtml.includes('id="mc2-col-discoveries"') &&
      missionControlJs.includes('mc2CollectKanbanCompletedItems') &&
      missionControlJs.includes('mc2CollectKanbanDiscoveryItems') &&
      missionControlJs.includes('MC2_KANBAN_DISPLAY_LIMIT = 5') &&
      missionControlJs.includes('Click to expand below for') &&
      missionControlJs.includes('data-mc-kanban-expand') &&
      missionControlJs.includes('mc2KanbanColExpanded') &&
      /function mc2RenderKanbanCol\([\s\S]*expandKey/.test(missionControlJs) &&
      !fullHtml.includes('>NOW <'),
  },
  {
    name: 'agent overview cards show event-driven last task summaries',
    ok: missionControlJs.includes('mc-agent-overview-last-task') &&
      missionControlJs.includes('Last task:') &&
      chat.includes('function buildAgentLastTaskSummary') &&
      chat.includes('window.buildAgentLastTaskSummary = buildAgentLastTaskSummary') &&
      !missionControlJs.includes('Focus:'),
  },
  {
    name: 'mission view scrolls when kanban content is long',
    ok: /#mc2-views-root > \.mc-view[\s\S]{0,320}overflow-y:\s*auto/.test(team2Css) &&
      /#mc2-views-root > \.mc-view > \*[\s\S]{0,80}flex:\s*0 0 auto/.test(team2Css) &&
      /#mc2-view-mission \.mc-bottom-row \.mc-panel-body[\s\S]{0,80}flex:\s*none/.test(team2Css) &&
      !/\.mc-kanban-col-body[\s\S]{0,120}overflow-y:\s*auto/.test(team2Css),
  },
  {
    name: 'attention items use task titles and auto-promoted tags',
    ok: !fullHtml.includes('id="mc2-action-banner"') &&
      !fullHtml.includes('ACTION REQUIRED') &&
      missionControlJs.includes('function mc2CollectActionRequiredItems') &&
      !missionControlJs.includes('function mc2RenderActionBanner') &&
      missionControlJs.includes("action: 'initiative-review'") &&
      missionControlJs.includes("tag: 'Auto-promoted'") &&
      missionControlJs.includes('function mc2TaskTitleForInitiative') &&
      !missionControlJs.includes("'Review auto-promoted initiative'"),
  },
  {
    name: 'task detail drawer renders structured mission task fields',
    ok: fullHtml.includes('id="mc2-task-drawer"') &&
      missionControlJs.includes('function mc2BuildTaskDetailHtml') &&
      missionControlJs.includes('function mc2OpenTaskDrawer') &&
      missionControlJs.includes('Source Chain') &&
      missionControlJs.includes('Assigned To') &&
      missionControlJs.includes('Skills Used') &&
      chat.includes('function enrichMissionTaskItem') &&
      chat.includes('function buildMissionTaskSourceChain') &&
      chat.includes('function buildMissionTaskInactionImpact') &&
      chat.includes('Auto archive in') &&
      missionControlJs.includes('If you do nothing') &&
      missionControlJs.includes('mc-task-inaction') &&
      chat.includes('Initiative Auto Promotion') &&
      chat.includes('function buildStructuredMissionTaskTimeline'),
  },
  {
    name: 'Home (mission) is default mission control landing view',
    ok: missionControlJs.includes("var mc2ActiveView = 'mission'") &&
      fullHtml.includes('id="mc2-view-tasks" class="mc-view" hidden') &&
      fullHtml.includes('id="mc2-view-mission" class="mc-view" role="main"') &&
      !/id="mc2-view-mission" class="mc-view" role="main" hidden/.test(fullHtml) &&
      /class="mc-nav-item active"[\s\S]{0,80}data-mc-nav="mission"/.test(fullHtml) &&
      fullHtml.includes('mc-nav-label">Home</span>') &&
      /data-mc-nav="mission"[\s\S]{0,220}data-mc-nav="tasks"/.test(fullHtml) &&
      missionControlJs.includes('window.mc2OpenTaskDetail = mc2OpenTaskDetail') &&
      missionControlJs.includes('mc2OpenTaskForInitiative') &&
      !fullHtml.includes('data-mc-nav="agents">View all blockers'),
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

function pickPort() {
  return 19000 + Math.floor(Math.random() * 1000);
}

async function waitForDashboard(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Dashboard not ready: ${url}`);
}

async function testDashboardServerStarts() {
  const port = pickPort();
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'pasture-dashboard-boot-'));
  let child = null;
  let stderr = '';
  try {
    child = spawn(process.execPath, ['dashboard/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PASTURE_STATE_DIR: stateDir,
        PASTURE_DASHBOARD_PORT: String(port),
        PASTURE_DASHBOARD_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitEarly = new Promise((_, reject) => {
      child.on('exit', (code) => {
        if (code != null && code !== 0) {
          reject(new Error(`Dashboard exited ${code}: ${stderr.slice(-800)}`));
        }
      });
    });
    await Promise.race([waitForDashboard(url), exitEarly]);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET / returned ${res.status}`);
    return `HTTP ${res.status} on port ${port}`;
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
      if (!child.killed) child.kill('SIGKILL');
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
}

async function main() {
  let failed = 0;
  for (const c of checks) {
    const status = c.ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${c.name}`);
    if (!c.ok) failed++;
  }

  const runtimeName = 'dashboard/server.js starts and serves GET /';
  try {
    const output = await testDashboardServerStarts();
    console.log(`[PASS] ${runtimeName}`);
    console.log(`       ${output}`);
  } catch (err) {
    console.log(`[FAIL] ${runtimeName}`);
    console.log(`       ${err?.message || err}`);
    failed++;
  }

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll dashboard boot checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
