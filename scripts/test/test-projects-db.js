#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-projects-'));
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const {
      createProject,
      updateProject,
      getProject,
      normalizeProjectUrl,
      getProjectsDb,
    } = await import('../../lib/projects-db.js');

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
