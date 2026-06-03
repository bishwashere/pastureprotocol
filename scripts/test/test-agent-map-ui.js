/**
 * Static checks for Agent team map layout (dashboard/public/index.html).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '../../dashboard/public');
const htmlPath = path.join(publicDir, 'index.html');
const assetsJsDir = path.join(publicDir, 'assets/js');
const appJs = fs.existsSync(assetsJsDir)
  ? fs.readdirSync(assetsJsDir)
    .filter((name) => /^\d{2}-.*\.js$/.test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(assetsJsDir, name), 'utf8'))
    .join('\n')
  : '';
const dashboardCss = fs.existsSync(path.join(publicDir, 'assets/css/dashboard.css'))
  ? fs.readFileSync(path.join(publicDir, 'assets/css/dashboard.css'), 'utf8')
  : '';
const pagesDir = path.join(publicDir, 'pages');
const pageFragments = fs.existsSync(pagesDir)
  ? fs.readdirSync(pagesDir)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => fs.readFileSync(path.join(pagesDir, name), 'utf8'))
    .join('\n')
  : '';
const partialsDir = path.join(publicDir, 'assets/partials');
function readPartial(name) {
  const p = path.join(partialsDir, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}
const html = [
  fs.readFileSync(htmlPath, 'utf8'),
  readPartial('nav.html'),
  readPartial('modals.html'),
  readPartial('project-edit-modal.html'),
  dashboardCss,
  appJs,
  pageFragments,
].join('\n');

const checks = [
  {
    name: 'Agent team panel does not use overflow:auto',
    ok: /\.chat-upper-right\s*\{[^}]*overflow:\s*hidden/s.test(html),
  },
  {
    name: 'Scaler wrapper exists for fit-to-container',
    ok: html.includes('id="agent-map-scaler"') && html.includes('agent-map-scaler'),
  },
  {
    name: 'Canvas fills remaining flex space',
    ok: /\.agent-map-canvas\s*\{[^}]*flex:\s*1\s+1\s+0/s.test(html),
  },
  {
    name: 'Tree connector arrow marker defined',
    ok: html.includes("markerPrefix + '-tree-arrowhead\""),
  },
  {
    name: 'Tree drop lines use arrow markers',
    ok: html.includes('agent-map-tree-line') && html.includes('-tree-arrowhead'),
  },
  {
    name: 'ResizeObserver redraw passes layout',
    ok: /drawAgentMapArrows\(agentMapData,\s*layout,\s*agentMapEls\(prefix\)/.test(html),
  },
  {
    name: 'Inbound link badge CSS exists',
    ok: html.includes('agent-map-node-inbound') && html.includes('agent-map-node-has-inbound'),
  },
  {
    name: 'Reply return arc CSS and marker exist',
    ok: html.includes('agent-map-reply-line') && html.includes("-reply-arrowhead"),
  },
  {
    name: 'Grey org-tree connectors not drawn',
    ok: !/agent-map-tree-line" marker-end="url\(#agent-tree-arrowhead\)"/.test(html),
  },
  {
    name: 'Agent edit modal includes identity file editor',
    ok: html.includes('agent-edit-modal-md-files') && html.includes('agent-edit-modal-md-textarea'),
  },
  {
    name: 'Agent team block has extension button',
    ok: html.includes('id="agent-team-ext-btn"') && html.includes('openTeamPage'),
  },
  {
    name: 'Dedicated team map page exists',
    ok: html.includes('id="page-team"') && html.includes('id="team-map-canvas"'),
  },
  {
    name: 'Team page has top-level Roster Goals Initiatives tabs',
    ok: html.includes('id="team-top-tab-roster"') &&
      html.includes('id="team-top-tab-goals"') &&
      html.includes('id="team-top-tab-initiatives"') &&
      html.includes('setTeamTopTab'),
  },
  {
    name: 'Team top tabs show one-line descriptions on switch',
    ok: html.includes('id="team-top-tab-desc"') &&
      html.includes('TEAM_TOP_TAB_DESC') &&
      html.includes('Long-running objectives your agents work on autonomously') &&
      html.includes('Proactive suggestions from goal reflection and team activity'),
  },
  {
    name: 'Team page includes goals UI and API hooks',
    ok: html.includes('id="team-goals-list"') &&
      html.includes('id="team-goal-create"') &&
      html.includes('/api/goals') &&
      html.includes('fetchGoalsSnapshot'),
  },
  {
    name: 'Team user input modal appears on team main view when mission needs input',
    ok: html.includes('id="team-user-input-modal"') &&
      html.includes('renderTeamUserInputModal') &&
      html.includes('isTeamMainViewActive') &&
      html.includes('shouldPauseTeamDashboardRefresh') &&
      html.includes('isTeamUserInputModalOpen') &&
      /if \(modalOpen\)[\s\S]{0,220}return;/.test(html) &&
      /function renderMissionControl\(\)[\s\S]{0,120}shouldPauseTeamDashboardRefresh/.test(html) &&
      html.includes('/api/goals/') &&
      html.includes('/respond') &&
      html.includes('team-user-input-modal-submit') &&
      html.includes('Implementation blocked') &&
      html.includes('Research continues'),
  },
  {
    name: 'Goals tab includes detail pane with subgoal tree',
    ok: html.includes('id="team-goal-detail"') &&
      html.includes('renderGoalDetail') &&
      html.includes('renderGoalSubgoalTree') &&
      html.includes('depends_on'),
  },
  {
    name: 'Initiatives tab includes list detail and API hooks',
    ok: html.includes('id="team-initiatives-view"') &&
      html.includes('id="team-initiatives-list"') &&
      html.includes('id="team-initiative-detail"') &&
      html.includes('/api/initiatives') &&
      html.includes('fetchInitiativesSnapshot') &&
      html.includes('renderInitiativesList'),
  },
  {
    name: 'Team page includes live activity panel',
    ok: html.includes('id="team-activity-list"') && html.includes('Live agent activity'),
  },
  {
    name: 'Team activity panel has collapse toggle',
    ok: html.includes('id="team-activity-toggle"') && html.includes('setTeamActivityExpanded'),
  },
  {
    name: 'Team activity panel defaults to collapsed',
    ok: html.includes('id="team-activity-wrap" class="team-rail-wrap team-activity-wrap collapsed"') &&
      html.includes("setTeamRailExpanded(key, false)"),
  },
  {
    name: 'Team page uses right-side split layout',
    ok: html.includes('class="team-page-body"') &&
      html.includes('id="team-roster-side"') &&
      /\.team-roster-side\s*\{[^}]*flex-direction:\s*column/s.test(html) &&
      /\.team-roster-side\s*\{[^}]*border-left:\s*1px/s.test(html),
  },
  {
    name: 'Expanded team rail takes full right side alone',
    ok: /\.team-roster-side:has\(\.team-rail-wrap\.expanded\)[\s\S]*\.team-rail-wrap\.collapsed\s*\{[^}]*display:\s*none/s.test(html) &&
      html.includes('teamRailExpanded[k] = k === key'),
  },
  {
    name: 'Team page has activity feed polling hooks',
    ok: html.includes('startTeamActivityFeed') && html.includes('/api/team/activity'),
  },
  {
    name: 'Team side rails include activity context inbox outbox stats',
    ok: html.includes('setTeamRailExpanded') &&
      html.includes('id="team-activity-wrap"') &&
      html.includes('id="team-context-wrap"') &&
      html.includes('id="team-inbox-wrap"') &&
      html.includes('id="team-outbox-wrap"') &&
      html.includes('id="team-stats-wrap"') &&
      /id="team-roster-side"[\s\S]*id="team-activity-wrap"[\s\S]*id="team-context-wrap"/.test(html),
  },
  {
    name: 'Team page has separate inbox and outbox rails',
    ok: html.includes('id="team-inbox-wrap"') &&
      html.includes('id="team-outbox-wrap"') &&
      html.includes('renderAgentOutbox') &&
      html.includes('filterFlowsForMailbox') &&
      html.includes('team-agent-inbox-list') &&
      html.includes('team-agent-outbox-list'),
  },
  {
    name: 'Team agent rails have time range submenu',
    ok: html.includes('team-agent-panel-range') &&
      html.includes('data-range="today"') &&
      html.includes('data-range="yesterday"') &&
      html.includes('data-range="last7"') &&
      html.includes('setTeamAgentPanelRange') &&
      html.includes('filterFlowsByTeamAgentRange'),
  },
  {
    name: 'Active Context is first agent detail rail after activity',
    ok: (() => {
      var activityIdx = html.indexOf('id="team-activity-wrap"');
      var contextIdx = html.indexOf('id="team-context-wrap"');
      var inboxIdx = html.indexOf('id="team-inbox-wrap"');
      return activityIdx >= 0 && contextIdx > activityIdx && inboxIdx > contextIdx &&
        html.includes('id="team-context-toggle"') &&
        /if \(pageId === 'team'\)[\s\S]*setTeamRailExpanded\('context', false\)/.test(html);
    })(),
  },
  {
    name: 'Team page includes active context view',
    ok: html.includes('id="team-context-wrap"') &&
      html.includes('id="team-agent-context-detail"') &&
      html.includes('renderAgentContext') &&
      html.includes('/api/team/context'),
  },
  {
    name: 'Active context panel shows mission thought waiting and last action',
    ok: html.includes('Current Mission:') &&
      html.includes('Current Thought:') &&
      html.includes('Waiting On:') &&
      html.includes('Last Action:') &&
      html.includes('resolveAgentContextDisplay') &&
      html.includes('currentThought'),
  },
  {
    name: 'Team page has View Active Only toggle',
    ok: html.includes('id="team-view-active-only"') &&
      html.includes('View Active Only') &&
      html.includes('setTeamViewActiveOnly') &&
      html.includes('getTeamAgentsForView'),
  },
  {
    name: 'Team page has cards and tree view tabs',
    ok: html.includes('id="team-view-tab-cards"') &&
      html.includes('id="team-view-tab-tree"') &&
      html.includes('id="team-agent-cards"') &&
      html.includes('setTeamViewTab'),
  },
  {
    name: 'Team page head has Current Mission and task summary below top tabs',
    ok: html.includes('id="team-current-mission"') &&
      html.includes('class="team-page-summary"') &&
      html.includes('id="team-task-summary"') &&
      html.includes('renderCurrentMission') &&
      html.includes('renderTeamTaskSummary') &&
      html.includes('computeTeamTaskSummary') &&
      html.includes('getCurrentMission') &&
      html.includes('getLiveMissionFromTeamContext') &&
      html.includes('missionSubgoalIcon') &&
      html.includes('Blocked:') &&
      html.includes('Completed Today') &&
      /\.team-page-summary[\s\S]*\.team-current-mission/.test(html) &&
      /\.team-task-summary[\s\S]*\.team-task-badge/.test(html),
  },
  {
    name: 'Team2 presents saved goals as missions',
    ok: html.includes('id="mc2-mission-select"') &&
      html.includes('data-mc-nav="initiatives"') &&
      html.includes('id="mc2-view-initiatives"') &&
      html.includes('id="mc2-initiatives-list"') &&
      html.includes('renderInitiatives') &&
      html.includes('mc2RenderInitiatives') &&
      html.includes('aria-label="Active mission"') &&
      html.includes('aria-label="Missions"') &&
      html.includes('MISSIONS') &&
      html.includes('INITIATIVES') &&
      html.includes('Loading missions') &&
      html.includes('Loading initiatives') &&
      html.includes('No missions yet') &&
      html.includes('Untitled mission') &&
      html.includes('Active mission'),
  },
  {
    name: 'Team2 inbox outbox and activity render distinct content',
    ok: html.includes('data-mc-nav="inbox"') &&
      html.includes('data-mc-nav="outbox"') &&
      html.includes('data-mc-nav="context"') &&
      html.includes('data-mc-nav="stats"') &&
      html.includes('id="mc2-inbox-agent-filter"') &&
      html.includes('id="mc2-context-agent-filter"') &&
      html.includes('id="mc2-stats-agent-filter"') &&
      html.includes('class="team-agent-panel-ranges mc2-range-controls"') &&
      html.includes('data-range="today"') &&
      html.includes('data-range="yesterday"') &&
      html.includes('data-range="last7"') &&
      html.includes('data-range="last30"') &&
      html.includes('Filter inbox by agent') &&
      html.includes('mc2InboxAgentFilter') &&
      html.includes('setTeamAgentPanelRange') &&
      html.includes('renderMissionControl();') &&
      html.includes("var visibleView = (view === 'inbox' || view === 'outbox') ? 'activity' : view") &&
      html.includes("mc2RenderMailbox(mc2ActiveView)") &&
      html.includes('mc2MailboxFlows') &&
      html.includes('mc2MailboxFlows(direction, range)') &&
      html.includes('filterFlowsForMailbox(buildAgentInboxFlows(agentId, activeRange), direction)') &&
      html.includes('mc2MailboxFlows(direction, \'all\')') &&
      html.includes('flow.entries.map(renderInboxEntry)') &&
      html.includes('mc2RenderContext') &&
      html.includes('renderAgentContextCard') &&
      html.includes('renderAgentContextHistory') &&
      html.includes('mc2RenderStats') &&
      html.includes('renderAgentMetricsCard') &&
      html.includes('mc2SyncAgentFilterControls') &&
      html.includes('mc2InferRangeFromTs') &&
      html.includes('mc2SetTimelineHighlight') &&
      html.includes('mc2SyncTimelineHighlightForScroll') &&
      html.includes('mc2ScrollToRange') &&
      html.includes('mc2ScrollViewAndFeed') &&
      html.includes('mc2FirstVisibleTsInScrollView') &&
      html.includes('mc2ContextSections') &&
      html.includes('mc2BindTimelineScrollSpy') &&
      html.includes("mc2ActiveView === 'context'") &&
      html.includes('data-ts=') &&
      html.includes('mc2EventMatchesAgent'),
  },
  {
    name: 'Team2 sidebar includes Tasks nav',
    ok: html.includes('class="mc-nav-item" data-mc-nav="tasks"') &&
      html.includes('mc-nav-label">Tasks</span>'),
  },
  {
    name: 'Team2 Done Today opens completed tasks cards view',
    ok: html.includes('data-mc-nav="tasks"') &&
      html.includes('mc-stat-card-action') &&
      html.includes('id="mc2-view-tasks"') &&
      html.includes('id="mc2-tasks-list"') &&
      html.includes('id="mc2-tasks-agent-filter"') &&
      html.includes('mc2RenderTasks') &&
      html.includes('mc2TaskDisplayTitle') &&
      html.includes('mc-task-card') &&
      html.includes('View tasks completed today'),
  },
  {
    name: 'Team2 Blocked stat navigates to blocked subgoal',
    ok: html.includes('data-mc-action="blocked"') &&
      html.includes('window.navigateToBlockedWork') &&
      html.includes('scheduleScrollToBlockedTarget') &&
      html.includes('navigateToBlockedWork') &&
      html.includes('scrollToBlockedSubgoalMarker') &&
      html.includes('findFirstBlockedWorkRef') &&
      html.includes('id="mc2-goal-detail"') &&
      html.includes('View blocked tasks and subtasks') &&
      html.includes('team-goal-subgoal-status blocked') &&
      html.includes('data-mc-action="blocked"') &&
      html.includes('scrollToFirstBlockedSubgoalTag'),
  },
  {
    name: 'Team page blocked badge is clickable',
    ok: html.includes('team-task-badge-action') &&
      html.includes('window.navigateToBlockedWork') &&
      html.includes('scheduleScrollToBlockedTarget') &&
      html.includes('navigateToBlockedWork') &&
      html.includes('data-mission-subgoal-id') &&
      html.includes('mission-blocked'),
  },
  {
    name: 'Team agent cards show state and active count',
    ok: html.includes('team-agent-card') &&
      html.includes('team-agent-card-active') &&
      html.includes(' active</div>') &&
      html.includes('renderTeamAgentCards') &&
      html.includes('agentCardActiveCount'),
  },
  {
    name: 'Team map nodes show live agent state',
    ok: html.includes('agent-map-node-state') &&
      html.includes('🟢 Working') &&
      html.includes('🟡 Waiting') &&
      html.includes('🔴 Error') &&
      html.includes('formatAgentStateDisplay'),
  },
  {
    name: 'Team page includes agent metrics stats rail',
    ok: html.includes('id="team-stats-wrap"') &&
      html.includes('id="team-agent-stats-detail"') &&
      html.includes('renderAgentMetrics') &&
      html.includes('/api/team/metrics'),
  },
  {
    name: 'Agent metrics shows tasks delegation and skills',
    ok: html.includes('Tasks handled:') &&
      html.includes('Delegated out:') &&
      html.includes('Received from others:') &&
      html.includes('Average execution:') &&
      html.includes('Most used skills:'),
  },
  {
    name: 'Team activity renders delegation decision confidence details',
    ok: html.includes("type === 'delegation_decision'") &&
      html.includes('renderRoutingFactors') &&
      html.includes('Contributing factors') &&
      html.includes('selectedScore') &&
      html.includes('assigned_to_you') &&
      html.includes('capability_evaluation') &&
      html.includes('team_capability_evaluation'),
  },
  {
    name: 'Team2 hash route without agent id opens roster map page',
    ok: /if \(name === 'team2'\)[\s\S]*return \{ name: 'team2', memoryFile: null, openIdentity: null, teamAgentId: null \}/.test(html),
  },
  {
    name: 'Legacy #team/agent hash opens edit modal on roster page',
    ok: /if \(name === 'team'\)[\s\S]*return \{ name: 'team2'[\s\S]*teamAgentId: decodeURIComponent\(subFile\)/.test(html) &&
      html.includes('openAgentEditModal(teamAgentId)') &&
      !/return \{ name: 'team-agent'/.test(html),
  },
  {
    name: 'Team map edit button opens modal not separate page',
    ok: html.includes('openAgentEditModal(aid)') &&
      !html.includes("location.hash = '#team/'"),
  },
  {
    name: 'Dedicated team agent editor page markup retained for legacy',
    ok: html.includes('id="page-team-agent"') && html.includes('id="team-agent-md-files"'),
  },
  {
    name: 'buildInboundLinks helper used on map',
    ok: /buildInboundLinks\(agents\)/.test(html),
  },
  {
    name: 'Top nav Team opens Mission Control route and Classic opens roster',
    ok: html.includes('data-page="team">Team</a>') &&
      html.includes('data-page="team2">Classic</a>') &&
      !html.includes('data-page="agents"'),
  },
  {
    name: 'Legacy #agents hash redirects to team2 roster route',
    ok: /if \(name === 'agents'\) name = 'team2';/.test(html),
  },
  {
    name: 'Team page has full screen toggle',
    ok: html.includes('id="team-page-fullscreen-btn"') &&
      html.includes('setTeamPageFullscreen') &&
      html.includes('toggleTeamPageFullscreen') &&
      html.includes('body.team-page-fullscreen') &&
      html.includes("sessionStorage.getItem('teamPageFullscreen')"),
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
console.log('\nAll agent map UI checks passed.');
