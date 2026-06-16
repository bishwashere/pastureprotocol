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
    } = await import('../../lib/context/projects-db.js');

    assert(normalizeProjectUrl('') === '', 'empty url');
    assert(normalizeProjectUrl('https://example.com') === 'https://example.com', 'https kept');
    assert(normalizeProjectUrl('nextpostai.com') === 'https://nextpostai.com', 'bare host gets https');

    const p1 = createProject({ name: 'NextPostAI', description: 'Onboarding work' });
    assert(p1.url === '', 'url optional on create');

    const p2 = createProject({
      name: 'Site',
      url: 'https://nextpostai.com',
      description: '',
    });
    assert(p2.url === 'https://nextpostai.com', `stored url: ${p2.url}`);

    const p3 = createProject({ name: 'Bare', url: 'app.example.io/path' });
    assert(p3.url === 'https://app.example.io/path', `normalized: ${p3.url}`);

    const updated = updateProject(p1.id, {
      name: 'Renamed',
      description: 'New desc',
      url: 'docs.example.com',
    });
    assert(updated.name === 'Renamed', `patch name: ${updated.name}`);
    assert(updated.description === 'New desc', `patch desc: ${updated.description}`);
    assert(updated.url === 'https://docs.example.com', `patch url: ${updated.url}`);

    const db = getProjectsDb();
    const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    assert(cols.includes('url'), 'projects table has url column');
    assert(cols.includes('setup_notes'), 'projects table has setup_notes column');
    assert(cols.includes('connectors_json'), 'projects table has connectors_json column');

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

    console.log('projects-db tests passed');
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
