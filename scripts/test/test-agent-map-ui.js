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
    name: 'Team hash route without agent id opens map page',
    ok: /if \(!subFile\)[\s\S]*name: 'team'/.test(html),
  },
  {
    name: 'Team hash route with agent id opens editor page',
    ok: /name: 'team-agent'/.test(html) && html.includes('teamAgentId: decodeURIComponent(subFile)'),
  },
  {
    name: 'Dedicated team agent editor page exists',
    ok: html.includes('id="page-team-agent"') && html.includes('id="team-agent-md-files"'),
  },
  {
    name: 'buildInboundLinks helper used on map',
    ok: /buildInboundLinks\(agents\)/.test(html),
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
