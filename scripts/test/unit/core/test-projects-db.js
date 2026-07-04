#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-projects-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const {
      createProject,
      updateProject,
      getProject,
      normalizeProjectUrl,
      getProjectsDb,
    } = await import('../../../../lib/context/projects-db.js');
    const { buildProjectTeamGateReply } = await import('../../../../lib/context/projects-context.js');

    assert(normalizeProjectUrl('') === '', 'empty url');
    assert(normalizeProjectUrl('https://example.com') === 'https://example.com', 'https kept');
    assert(normalizeProjectUrl('nextpostai.com') === 'https://nextpostai.com', 'bare host gets https');

    const p1 = createProject({ name: 'NextPostAI', description: 'Onboarding work', team_id: 'default' });
    assert(p1.url === '', 'url optional on create');
    assert(p1.team_id === 'default', `team id on create: ${p1.team_id}`);

    const p2 = createProject({
      name: 'Site',
      url: 'https://nextpostai.com',
      description: '',
    });
    assert(p2.url === 'https://nextpostai.com', `stored url: ${p2.url}`);
    assert(p2.team_id === '', `project can be unassigned from team: ${p2.team_id}`);

    const p3 = createProject({ name: 'Bare', url: 'app.example.io/path' });
    assert(p3.url === 'https://app.example.io/path', `normalized: ${p3.url}`);

    const updated = updateProject(p1.id, {
      name: 'Renamed',
      description: 'New desc',
      url: 'docs.example.com',
      team_id: 'Growth Team',
    });
    assert(updated.name === 'Renamed', `patch name: ${updated.name}`);
    assert(updated.description === 'New desc', `patch desc: ${updated.description}`);
    assert(updated.url === 'https://docs.example.com', `patch url: ${updated.url}`);
    assert(updated.team_id === 'growth-team', `patch team_id: ${updated.team_id}`);

    const db = getProjectsDb();
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    assert(cols.includes('url'), 'projects table has url column');
    assert(cols.includes('setup_notes'), 'projects table has setup_notes column');
    assert(cols.includes('connectors_json'), 'projects table has connectors_json column');
    assert(cols.includes('team_id'), 'projects table has team_id column');

    const withSetup = createProject({
      name: 'WithSetup',
      description: 'Has notes',
      setup_notes: 'mongodb://localhost/test',
    });
    assert(withSetup.setup_notes.includes('mongodb'), `setup notes: ${withSetup.setup_notes}`);

    const withConnectors = updateProject(p1.id, {
      connectors: {
        github: { repo: 'owner/repo' },
        mongodb: {
          uri: 'mongodb://localhost:27017/app',
          collections: { analytics: 'analytics-user' },
        },
      },
    });
    assert(withConnectors.connectors.github.repo === 'owner/repo', 'github connector saved');
    assert(withConnectors.connectors.mongodb.uri.includes('mongodb'), 'mongodb connector saved');
    assert(withConnectors.connectors.mongodb.collections.analytics === 'analytics-user', 'mongodb collection hint saved');

    const withMongoPatch = updateProject(p1.id, {
      connectors: {
        mongodb: { collections: { billing: 'billing-events' } },
      },
    });
    assert(withMongoPatch.connectors.mongodb.uri.includes('mongodb'), 'mongodb uri preserved on collection patch');
    assert(withMongoPatch.connectors.mongodb.collections.billing === 'billing-events', 'mongodb collection patch saved');

    const reloaded = getProject(p2.id);
    assert(reloaded.name === 'Site' && reloaded.url === 'https://nextpostai.com', 'reload ok');

    createProject({ name: 'DefaultTeamProject', team_id: 'default' });
    const gate = buildProjectTeamGateReply({
      agentId: 'main',
      agentTeamId: 'default',
      focusedProject: null,
      focusedProjectTeamId: '',
    });
    assert(gate.includes('Multi-agent work needs a project'), `gate reply: ${gate}`);

    console.log('projects-db tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
