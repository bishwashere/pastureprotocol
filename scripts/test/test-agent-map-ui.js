/**
 * Static checks for Agent team map layout (dashboard/public/index.html).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, '../../dashboard/public/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

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
    name: 'Team page includes live activity panel',
    ok: html.includes('id="team-activity-list"') && html.includes('Live agent activity'),
  },
  {
    name: 'Team activity panel has collapse toggle',
    ok: html.includes('id="team-activity-toggle"') && html.includes('setTeamActivityExpanded'),
  },
  {
    name: 'Team activity panel defaults to collapsed',
    ok: html.includes('id="team-activity-wrap" class="team-activity-wrap collapsed"') && html.includes('setTeamActivityExpanded(false);'),
  },
  {
    name: 'Team page uses right-side split layout',
    ok: html.includes('class="team-page-body"') && /\.team-activity-wrap\s*\{[^}]*border-left:\s*1px/s.test(html),
  },
  {
    name: 'Team page has activity feed polling hooks',
    ok: html.includes('startTeamActivityFeed') && html.includes('/api/team/activity'),
  },
  {
    name: 'Team page includes agent inbox below map',
    ok: html.includes('id="team-agent-panel"') &&
      html.includes('team-agent-inbox-list') &&
      html.includes('selectTeamInboxAgent'),
  },
  {
    name: 'Team page includes active context view',
    ok: html.includes('id="team-agent-tab-context"') &&
      html.includes('id="team-agent-context-detail"') &&
      html.includes('renderAgentContext') &&
      html.includes('/api/team/context'),
  },
  {
    name: 'Team page has cards and tree view tabs',
    ok: html.includes('id="team-view-tab-cards"') &&
      html.includes('id="team-view-tab-tree"') &&
      html.includes('id="team-agent-cards"') &&
      html.includes('setTeamViewTab'),
  },
  {
    name: 'Team agent cards show state last and today',
    ok: html.includes('team-agent-card') &&
      html.includes('team-agent-card-last') &&
      html.includes(' today</div>') &&
      html.includes('renderTeamAgentCards'),
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
    name: 'Team page includes agent metrics stats tab',
    ok: html.includes('id="team-agent-tab-stats"') &&
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
      html.includes('<strong>Reason:</strong>') &&
      html.includes('<strong>Candidate Agents:</strong>') &&
      html.includes('selectedConfidence'),
  },
  {
    name: 'Team hash route without agent id opens map page',
    ok: /if \(!subFile\)[\s\S]*name: 'team'/.test(html),
  },
  {
    name: 'Team hash route with agent id opens edit modal on team page',
    ok: /if \(name === 'team'\)[\s\S]*teamAgentId: decodeURIComponent\(subFile\)/.test(html) &&
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
    name: 'Top nav uses Team (no Agents tab)',
    ok: html.includes('data-page="team"') && !html.includes('data-page="agents"'),
  },
  {
    name: 'Legacy #agents hash redirects to team route',
    ok: /if \(name === 'agents'\) name = 'team';/.test(html),
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
