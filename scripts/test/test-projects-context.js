#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-proj-ctx-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const { createProject } = await import('../../lib/projects-db.js');
    const {
      buildProjectsContextBlock,
      formatProjectsForPrompt,
      formatProjectsProfileLine,
      pickFocusedProject,
      enrichMessageWithProjectContext,
      getProjectsDiscoveryIntentHint,
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
    assert(block.includes('Active project focus'), 'focus block');
    assert(block.includes('investigate first'), 'investigate first');
    assert(block.includes('github'), 'github instruction');
    assert(block.includes('filesystem'), 'filesystem instruction');
    assert(block.includes('confirm'), 'confirm after');
    assert(block.includes('nextpostai.com'), 'url in block');

    const enriched = enrichMessageWithProjectContext('find out what it is about');
    assert(enriched.includes('Projects tracker context'), 'enriched delegation');
    assert(enriched.includes('nextpostai'), 'project name in enrichment');
    assert(enriched.includes('github'), 'enriched mentions github');
    assert(enriched.includes('filesystem'), 'enriched mentions filesystem');

    const hint = getProjectsDiscoveryIntentHint(
      'what is this project all about',
      [],
      ['browse', 'github', 'memory', 'go-read', 'read', 'search'],
    );
    assert(hint && hint.skills.includes('browse'), 'intent includes browse');
    assert(hint.skills.includes('github'), 'intent includes github');
    assert(hint.plan.includes('before checking'), 'intent plan');

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
