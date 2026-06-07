#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-missions-ctx-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createProject } = await import('../../lib/projects-db.js');
    const { createMission } = await import('../../lib/missions.js');
    const {
      resolveMissionForUserTurn,
      buildMissionsContextBlock,
      getMissionsDiscoveryIntentHint,
      isWorkOrDiscoveryRequest,
      missionLabelForAgentContext,
    } = await import('../../lib/missions-context.js');

    assert(isWorkOrDiscoveryRequest('find out what this project is about'), 'work request');

    createProject({
      name: 'nextpostai',
      description: 'AI marketing',
      url: 'https://nextpostai.com',
    });
    const mission = createMission({
      title: 'Research nextpostai',
      objective: 'Learn what nextpostai is and document findings',
      ownerAgentId: 'developer',
    });

    const resolved = resolveMissionForUserTurn({
      userText: 'what is this project all about find out',
      historyMessages: [],
      agentId: 'developer',
    });
    assert(resolved && resolved.id === mission.id, 'mission resolved via project name');

    const block = buildMissionsContextBlock({
      userText: 'what is this project all about find out',
      historyMessages: [],
      agentId: 'developer',
    });
    assert(block.includes('Active mission'), 'mission block header');
    assert(block.includes('nextpostai'), 'related project in block');
    assert(block.includes('tools') && block.includes('confirm'), 'work instructions');
    assert(block.includes('Research nextpostai'), 'mission title');

    const hint = getMissionsDiscoveryIntentHint(
      'find out what this is about',
      [],
      ['browse', 'github', 'memory', 'search'],
      'developer',
    );
    assert(hint && hint.skills.includes('browse'), 'intent includes browse');
    assert(hint.plan.includes('mission'), 'intent references mission');

    assert(missionLabelForAgentContext(mission).includes('Research'), 'mission label');

    console.log('missions-context tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
