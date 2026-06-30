#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '../../../../dashboard/public');
const html = readFileSync(join(__dirname, '../../../../dashboard/public/index.html'), 'utf8');
const team2 = readFileSync(join(publicDir, 'pages/team2.html'), 'utf8');
const mc2Projects = readFileSync(join(publicDir, 'pages/mc2/view-projects.html'), 'utf8');
const projectsJs = readFileSync(join(publicDir, 'assets/js/06-projects.js'), 'utf8');
const team2Css = readFileSync(join(publicDir, 'assets/css/team2.css'), 'utf8');
const serverJs = readFileSync(join(__dirname, '../../../../dashboard/server.js'), 'utf8');

const projectModal = readFileSync(join(publicDir, 'assets/partials/project-edit-modal.html'), 'utf8');

const checks = [
  {
    name: 'Project edit modal exists',
    ok: projectModal.includes('id="project-edit-modal"') &&
      projectModal.includes('id="project-edit-name"') &&
      projectModal.includes('id="project-edit-url"') &&
      projectModal.includes('id="project-edit-desc"'),
  },
  {
    name: 'Project root has pencil edit control',
    ok: projectsJs.includes('proj-root-edit') &&
      projectsJs.includes('openProjectEditModal') &&
      projectsJs.includes('submitProjectEditModal'),
  },
  {
    name: 'Project edit uses PATCH API',
    ok: projectsJs.includes("projFetch('/projects/' + projectEditModalId") &&
      projectsJs.includes("method: 'PATCH'"),
  },
  {
    name: 'Team projects view has Connector section',
    ok: team2.includes('MC2_VIEWS') &&
      mc2Projects.includes('id="mc2-proj-connectors"') &&
      mc2Projects.includes('CONNECTOR') &&
      projectsJs.includes('renderMc2Connectors') &&
      projectsJs.includes("id: 'github'") &&
      projectsJs.includes("id: 'mongodb'"),
  },
  {
    name: 'MongoDB connector supports collection hints',
    ok: projectsJs.includes('data-mongo-map-key') &&
      projectsJs.includes('data-mongo-map-collection') &&
      projectsJs.includes('collections: normalizeMongoCollections') &&
      projectsJs.includes('analytics-user') &&
      team2Css.includes('.mc2-mongo-map'),
  },
  {
    name: 'Standalone Projects nav/page removed (Team hosts projects)',
    ok: !readFileSync(join(publicDir, 'assets/partials/nav.html'), 'utf8').includes('data-page="projects"') &&
      !mc2Projects.includes('Open full editor') &&
      readFileSync(join(publicDir, 'assets/js/01-core-router-status.js'), 'utf8').includes("name === 'projects'"),
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
console.log('\nAll projects UI checks passed.');
