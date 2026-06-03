#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-proj-ctx-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createProject } = await import('../../lib/projects-db.js');
    const {
      buildProjectsContextBlock,
      formatProjectsForPrompt,
      formatProjectsProfileLine,
      pickFocusedProject,
      enrichMessageWithProjectContext,
      isProjectDiscoveryRequest,
    } = await import('../../lib/projects-context.js');

    assert(formatProjectsForPrompt([]).includes('No projects'), 'empty list copy');
    assert(isProjectDiscoveryRequest('what is this project all about find out'), 'discovery phrase');

    createProject({
      name: 'nextpostai',
      description: 'AI marketing tool',
      url: 'https://nextpostai.com',
    });

    const projects = [{ name: 'nextpostai', description: 'AI marketing tool', url: 'https://nextpostai.com' }];
    const focus = pickFocusedProject(projects, 'what is this project all about find out', []);
    assert(focus && focus.name === 'nextpostai', 'single project focus');

    const block = buildProjectsContextBlock({
      userText: 'what is this project all about find out',
      historyMessages: [],
    });
    assert(block.includes('Dashboard projects'), 'catalog block');
    assert(block.includes('Active goal'), 'points to goals');
    assert(block.includes('nextpostai.com'), 'url in list');

    const enriched = enrichMessageWithProjectContext('find out what it is about');
    assert(enriched.includes('Projects tracker'), 'enriched delegation');
    assert(enriched.includes('nextpostai'), 'project name in enrichment');
    assert(enriched.includes('matching Goal'), 'enriched points to goal');

    const profile = formatProjectsProfileLine();
    assert(profile.includes('1 project'), `profile: ${profile}`);

    console.log('projects-context tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
