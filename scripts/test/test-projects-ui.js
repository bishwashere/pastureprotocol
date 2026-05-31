#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '../../dashboard/public/index.html'), 'utf8');

const checks = [
  {
    name: 'Project edit modal exists',
    ok: html.includes('id="project-edit-modal"') &&
      html.includes('id="project-edit-name"') &&
      html.includes('id="project-edit-url"') &&
      html.includes('id="project-edit-desc"'),
  },
  {
    name: 'Project root has pencil edit control',
    ok: html.includes('proj-root-edit') &&
      html.includes('openProjectEditModal') &&
      html.includes('submitProjectEditModal'),
  },
  {
    name: 'Project edit uses PATCH API',
    ok: html.includes("projFetch('/projects/' + projectEditModalId") &&
      html.includes("method: 'PATCH'"),
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
