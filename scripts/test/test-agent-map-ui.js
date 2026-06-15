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

function readDashboardJs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return readDashboardJs(fullPath);
      if (/^\d{2}-.*\.js$/.test(entry.name)) return [fullPath];
      return [];
    })
    .sort();
}

const appJs = readDashboardJs(assetsJsDir)
  .map((filePath) => fs.readFileSync(filePath, 'utf8'))
  .join('\n');
const dashboardCss = fs.existsSync(path.join(publicDir, 'assets/css/dashboard.css'))
  ? fs.readFileSync(path.join(publicDir, 'assets/css/dashboard.css'), 'utf8')
  : '';
const team2Css = fs.existsSync(path.join(publicDir, 'assets/css/team.css'))
  ? fs.readFileSync(path.join(publicDir, 'assets/css/team.css'), 'utf8')
  : '';
const pagesDir = path.join(publicDir, 'pages');

function readHtmlFragments(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return readHtmlFragments(fullPath);
      if (entry.name.endsWith('.html')) return [fullPath];
      return [];
    })
    .sort();
}

const pageFragments = readHtmlFragments(pagesDir)
  .map((filePath) => fs.readFileSync(filePath, 'utf8'))
  .join('\n');
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
  team2Css,
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
    name: 'Team page (MC2) exists with correct id',
    ok: html.includes('id="page-team"') && html.includes('id="mc2-mission-select"'),
  },
  {
    name: 'Team page (MC2) has mission select and delete button',
    ok: html.includes('id="mc2-mission-select"') &&
      html.includes('id="mc2-mission-delete-btn"') &&
      html.includes('/api/missions'),
  },
  {
    name: 'Team page (MC2) has mission API hooks',
    ok: html.includes('/api/missions') && html.includes('fetchMissionsSnapshot'),
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
      html.includes('/api/missions/') &&
      html.includes('/respond') &&
      html.includes('team-user-input-modal-submit') &&
      html.includes('Implementation blocked') &&
      html.includes('Research continues'),
  },
  {
    name: 'MC2 missions view has detail pane and task tree logic',
    ok: html.includes('renderMissionDetail') &&
      html.includes('renderMissionTaskTree') &&
      html.includes('dependsOn'),
  },
  {
    name: 'AI suggestions are handled as task-labeled work',
    ok: !html.includes('id="team-suggestedTasks-view"') &&
      html.includes('/api/suggestedTasks') &&
      html.includes('fetchSuggestedTasksSnapshot') &&
      html.includes('renderSuggestedTasksList') &&
      html.includes('mc-task-card-label') &&
      html.includes('AI suggested'),
  },
  {
    name: 'Task UI filters chat-derived delegated status rows',
    ok: html.includes('mc2IsChatDerivedDelegatedTask') &&
      html.includes('mc2LooksLikeProjectMetaTaskText') &&
      /if \(mc2IsChatDerivedDelegatedTask\(sg\)\) return;/.test(html),
  },
  {
    name: 'MC2 team page has live activity feed hooks',
    ok: html.includes('startTeamActivityFeed') && html.includes('teamActivityEvents'),
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
    name: 'MC2 agents view has inbox and outbox logic',
    ok: html.includes('renderAgentOutbox') &&
      html.includes('filterFlowsForMailbox'),
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
    name: 'MC2 agents view has active context rendering',
    ok: html.includes('renderAgentContext') && html.includes('/api/team/context'),
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
    name: 'MC2 team page has agent filter and view logic',
    ok: html.includes('setTeamViewActiveOnly') &&
      html.includes('getTeamAgentsForView') &&
      html.includes('mc2SetAgentFilter'),
  },
  {
    name: 'MC2 team page mission progress and task summary logic',
    ok: html.includes('renderCurrentMission') &&
      html.includes('renderTeamTaskSummary') &&
      html.includes('computeTeamTaskSummary') &&
      html.includes('getCurrentMission') &&
      html.includes('getLiveMissionFromTeamContext'),
  },
  {
    name: 'Team2 presents saved missions as missions',
    ok: html.includes('id="mc2-mission-select"') &&
      !html.includes('data-mc-nav="suggestedTasks"') &&
      html.includes('data-mc-nav="tasks"') &&
      html.includes('id="mc2-view-tasks"') &&
      html.includes('mc-task-card-label') &&
      html.includes('AI suggested') &&
      html.includes('data-init-action="approve-task"') &&
      html.includes('data-init-action="undo-promotion"') &&
      html.includes('suggestedTask_auto_promoted') &&
      html.includes('Added suggestedTask to mission') &&
      html.includes('data-mc-movement-nav') &&
      html.includes('buildMissionControlMovementGroups') &&
      html.includes('MC2_PINNED_MOVEMENT_TYPES') &&
      appJs.includes('return out.sort(function (a, b)') &&
      html.includes('missionTaskActionButtonsHtml') &&
      html.includes('wireMissionTaskActions') &&
      html.includes('data-mc-mission-action') &&
      html.includes('review-suggestedTask') &&
      html.includes('id="mc2-task-detail"') &&
      html.includes('class="mc-task-popup"') &&
      html.includes('mc-task-popup-card') &&
      html.includes('data-mc-task-drawer-close') &&
      html.includes("closest('.mc-task-popup-card')") &&
      html.includes('mc2OpenTaskDetail') &&
      html.includes('buildMissionTaskTimeline') &&
      html.includes('mc-task-timeline') &&
      html.includes('aria-label="Active mission"') &&
      html.includes('aria-label="Missions"') &&
      html.includes('MISSIONS') &&
      html.includes('Loading missions') &&
      html.includes('No missions yet') &&
      html.includes('Untitled mission') &&
      html.includes('Active mission'),
  },
  {
    name: 'Team2 shows context inbox and outbox at bottom of Agents page',
    ok: !html.includes('class="mc-nav-item" data-mc-nav="inbox"') &&
      !html.includes('class="mc-nav-item" data-mc-nav="outbox"') &&
      !html.includes('class="mc-nav-item" data-mc-nav="context"') &&
      !html.includes('mc-nav-label">Settings</span>') &&
      html.includes('Agent workspace') &&
      html.includes('Context, Inbox, and Outbox show all agents by default') &&
      html.includes('id="mc2-agents-agent-filter"') &&
      html.includes('class="mc-agents-workspace"') &&
      html.includes('class="mc-agents-workspace-grid"') &&
      html.includes('id="mc2-agents-panel-context"') &&
      html.includes('id="mc2-agents-panel-inbox"') &&
      html.includes('id="mc2-agents-panel-outbox"') &&
      html.includes("mc2SetAgentFilter(contextLink.getAttribute('data-mc-agent') || '', 'context')") &&
      html.includes('id="mc2-agents-context-list"') &&
      html.includes('id="mc2-agents-inbox-feed"') &&
      html.includes('id="mc2-agents-outbox-feed"') &&
      html.includes('mc2SetAgentsSubView') &&
      !html.includes('data-mc-nav="stats"') &&
      html.includes('id="mc2-inbox-agent-filter"') &&
      html.includes('id="mc2-context-agent-filter"') &&
      !html.includes('id="mc2-stats-agent-filter"') &&
      html.includes('class="team-agent-panel-ranges mc2-range-controls"') &&
      html.includes('data-range="today"') &&
      html.includes('data-range="yesterday"') &&
      html.includes('data-range="last7"') &&
      html.includes('data-range="last30"') &&
      html.includes('Filter inbox by agent') &&
      html.includes('mc2InboxAgentFilter') &&
      html.includes('setTeamAgentPanelRange') &&
      html.includes('renderMissionControl();') &&
      html.includes("var visibleView = (view === 'context' || view === 'inbox' || view === 'outbox') ? 'agents' : view") &&
      html.includes("mc2RenderMailbox('inbox')") &&
      html.includes("mc2RenderMailbox('outbox')") &&
      html.includes('mc2MailboxFlows') &&
      html.includes('mc2MailboxFlows(direction, range)') &&
      html.includes('filterFlowsForMailbox(buildAgentInboxFlows(agentId, activeRange), direction)') &&
      html.includes('mc2MailboxFlows(direction, \'all\')') &&
      html.includes('flow.entries.map(renderInboxEntry)') &&
      html.includes('mc2RenderContext') &&
      html.includes('renderAgentContextCard') &&
      html.includes('renderAgentContextHistory') &&
      html.includes('mc2RenderAgentStatsForTaskMenu') &&
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
      html.includes("mc2ActiveView === 'agents'") &&
      html.includes('data-ts=') &&
      html.includes('mc2EventMatchesAgent'),
  },
  {
    name: 'Team2 sidebar includes Tasks nav',
    ok: html.includes('class="mc-nav-item" data-mc-nav="tasks"') &&
      html.includes('mc-nav-label">Tasks</span>'),
  },
  {
    name: 'Team2 task page uses compact tile grid',
    ok: /\.mc-tasks-section-body\s*\{[\s\S]{0,180}display:\s*grid/.test(html) &&
      /\.mc-tasks-section-body\s*\{[\s\S]{0,220}grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(10rem,\s*1fr\)\)/.test(html) &&
      /\.mc-task-card-desc\s*\{[\s\S]{0,220}-webkit-line-clamp:\s*2/.test(html),
  },
  {
    name: 'Team2 Completed stat scrolls to completed kanban column',
    ok: html.includes('data-kanban-col="completed"') &&
      html.includes('function mc2FocusKanbanColumn') &&
      html.includes('id="mc2-view-tasks"') &&
      html.includes('id="mc2-tasks-list"') &&
      html.includes('mc2RenderTasks') &&
      html.includes('listCanonicalWorkItems') &&
      html.includes('mc2MissionTaskCard') &&
      html.includes('mc-task-card') &&
      html.includes('Completed') &&
      html.includes('WORK COMPLETED'),
  },
  {
    name: 'Team2 home stat cards share kanban count collectors',
    ok: html.includes('function computeMc2HomeCounts') &&
      html.includes('mc2CollectKanbanProgressItems().length') &&
      html.includes('mc2CollectKanbanOpenItems().length') &&
      html.includes('mc2CollectKanbanAttentionItems().length') &&
      html.includes('mc2CollectKanbanProposedItems().length') &&
      html.includes('function mc2CollectBlockersNeedingAttention') &&
      html.includes('function mc2CollectApprovalQueueItems') &&
      html.includes('id="mc2-stat-open"') &&
      html.includes('id="mc2-stat-attention"') &&
      html.includes('id="mc2-stat-proposed"') &&
      html.includes('id="mc2-col-proposed"') &&
      html.includes('PROPOSED') &&
      html.includes('data-mc-action="kanban-focus"') &&
      html.includes('View proposed items'),
  },
  {
    name: 'Team2 attention lists blocked tasks needing input',
    ok: html.includes('countBlockedTasksForMission') &&
      html.includes('missionNeedsAttention') &&
      html.includes('missionAttentionPrompt') &&
      html.includes('formatUserInputQuestionHtml') &&
      html.includes('extractUserInputQuickOptions') &&
      html.includes('data-mc-task-action="respond"'),
  },
  {
    name: 'Team page blocked badge is clickable',
    ok: html.includes('team-task-badge-action') &&
      html.includes('window.navigateToBlockedWork') &&
      html.includes('scheduleScrollToBlockedTarget') &&
      html.includes('navigateToBlockedWork') &&
      html.includes('data-mission-task-id') &&
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
    name: 'Team page has agent metrics rendering logic',
    ok: html.includes('renderAgentMetrics') && html.includes('/api/team/metrics'),
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
    name: 'Team hash route without agent id opens MC2 page',
    ok: /if \(name === 'team'[\s\S]*return \{ name: 'team', memoryFile: null, openIdentity: null, teamAgentId: null \}/.test(html),
  },
  {
    name: 'Legacy #team/agent hash opens edit modal on team page',
    ok: /if \(name === 'team'[\s\S]*teamAgentId: decodeURIComponent\(subFile\)/.test(html) &&
      html.includes('openAgentEditModal(teamAgentId)') &&
      !/return \{ name: 'team-agent'/.test(html),
  },
  {
    name: 'Team agent cards have edit menu',
    ok: html.includes('renderAgentCardMenuButton') &&
      html.includes('wireAgentCardMenus') &&
      html.includes('agent-card-menu-item') &&
      html.includes('Edit agent'),
  },
  {
    name: 'Agent edit modal includes LLM priority mode',
    ok: html.includes('agent-edit-modal-llm-priority') &&
      html.includes('System (use project default)') &&
      html.includes('agent-edit-modal-llm-models') &&
      html.includes('renderAgentEditorLlmModelPicker'),
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
    name: 'Top nav has single Team link (no separate Classic link)',
    ok: html.includes('data-page="team">Team</a>') &&
      !html.includes('data-page="team2"') &&
      !html.includes('data-page="agents"'),
  },
  {
    name: 'Legacy #agents hash redirects to team route',
    ok: /if \(name === 'agents'\) name = 'team';/.test(html),
  },
  {
    name: 'Team page has fullscreen JS logic',
    ok: html.includes('setTeamPageFullscreen') &&
      html.includes('toggleTeamPageFullscreen') &&
      html.includes('body.team-page-fullscreen'),
  },
  {
    name: 'mc2TaskDisplayTitle filters out mission tick system prompt',
    ok: /You are executing a persistent background mission tick/i.test(appJs),
  },
];

let failed = 0;
for (const c of checks) {
  const status = c.ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${c.name}`);
  if (!c.ok) failed++;
}

// ── Behavioral unit tests for mc2TaskDisplayTitle ────────────────────────────
// Extract the function from the source and evaluate it to verify filtering.
{
  // Build a minimal browser-like scope and eval the function
  const fnMatch = appJs.match(/function mc2TaskDisplayTitle\(task\)\s*\{[\s\S]*?\n    \}/);
  if (!fnMatch) {
    console.error('[FAIL] mc2TaskDisplayTitle function not found in source');
    failed++;
  } else {
    // eslint-disable-next-line no-new-func
    const mc2TaskDisplayTitle = new Function('task', fnMatch[0].replace('function mc2TaskDisplayTitle(task) ', '').replace(/^\{/, '').replace(/\}$/, ''));

    const TICK_PROMPT = 'You are executing a persistent background mission tick. Mission ID: mission-abc123 Mission title: Grow NextPostAI';
    const USER_PROMPT = 'What is the status of our launch?';
    const HANDLED_MSG = 'Handled in 3600ms using 3 skills.';
    const COMPLETED_MSG = 'Completed turn successfully.';

    const behaviorChecks = [
      {
        name: 'mc2TaskDisplayTitle: mission tick prompt → falls through to summary',
        input: { prompt: TICK_PROMPT, summary: 'Ran competitive analysis.' },
        expected: 'Ran competitive analysis.',
      },
      {
        name: 'mc2TaskDisplayTitle: mission tick prompt with no summary → "Completed task"',
        input: { prompt: TICK_PROMPT, summary: '' },
        expected: 'Completed task',
      },
      {
        name: 'mc2TaskDisplayTitle: real user message → used as title',
        input: { prompt: USER_PROMPT, summary: 'Some summary' },
        expected: USER_PROMPT,
      },
      {
        name: 'mc2TaskDisplayTitle: "Handled in N ms" prompt → falls through to summary',
        input: { prompt: HANDLED_MSG, summary: 'Drafted onboarding email.' },
        expected: 'Drafted onboarding email.',
      },
      {
        name: 'mc2TaskDisplayTitle: "Completed turn" prompt → falls through to summary',
        input: { prompt: COMPLETED_MSG, summary: 'Finished sprint review.' },
        expected: 'Finished sprint review.',
      },
    ];

    for (const bc of behaviorChecks) {
      try {
        const result = mc2TaskDisplayTitle(bc.input);
        const ok = result === bc.expected;
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${bc.name}`);
        if (!ok) {
          console.error(`  Expected: "${bc.expected}"\n  Got:      "${result}"`);
          failed++;
        }
      } catch (err) {
        console.error(`[FAIL] ${bc.name} — ${err.message}`);
        failed++;
      }
    }
  }
}

// ── Behavioral unit tests for mc2GenericTaskNoise ────────────────────────────
// Read shared JS source and eval mc2GenericTaskNoise directly.
{
  const sharedJs = readDashboardJs(assetsJsDir)
    .filter((p) => p.includes('04-mc2-shared'))
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('');

  const noiseFnMatch = sharedJs.match(/function mc2GenericTaskNoise\(text\)\s*\{[\s\S]*?\n    \}/);
  if (!noiseFnMatch) {
    console.error('[FAIL] mc2GenericTaskNoise not found in 04-mc2-shared.js');
    failed++;
  } else {
    // Build the function with stubs for the helpers it calls
    const body = noiseFnMatch[0]
      .replace('function mc2GenericTaskNoise(text) ', '')
      .replace(/isEphemeralMissionLabel\([^)]+\)/g, 'false');
    // eslint-disable-next-line no-new-func
    const mc2GenericTaskNoise = new Function('text', body.slice(1, -1));

    const noiseChecks = [
      { label: 'mission tick prompt is noise', input: 'You are executing a persistent background mission tick. Mission ID: m-123', expected: true },
      { label: '"Received reply from developer" is noise', input: 'Received reply from developer', expected: true },
      { label: '"Received delegated task from main" is noise', input: 'Received delegated task from main', expected: true },
      { label: '"Delegation to marketer failed: timeout" is noise', input: 'Delegation to marketer failed: timeout', expected: true },
      { label: '"Task failed: network error" is noise', input: 'Task failed: network error', expected: true },
      { label: 'real user message is NOT noise', input: 'What is the status of our chess999 launch?', expected: false },
      { label: 'real task title is NOT noise', input: 'Clarify what Chess999 is (ruleset, platform, target users)', expected: false },
    ];

    for (const nc of noiseChecks) {
      try {
        const result = mc2GenericTaskNoise(nc.input);
        const ok = result === nc.expected;
        console.log(`[${ok ? 'PASS' : 'FAIL'}] mc2GenericTaskNoise: ${nc.label}`);
        if (!ok) {
          console.error(`  Expected: ${nc.expected}\n  Got:      ${result}\n  Input:    "${nc.input}"`);
          failed++;
        }
      } catch (err) {
        console.error(`[FAIL] mc2GenericTaskNoise: ${nc.label} — ${err.message}`);
        failed++;
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll agent map UI checks passed.');
