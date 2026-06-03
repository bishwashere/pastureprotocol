#!/usr/bin/env node
/**
 * Re-split dashboard/public/index.html into assets/ (run only if restoring from monolith backup).
 * Normal workflow: edit assets/js/*.js and assets/css/*.css directly.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'dashboard/public');
const htmlPath = path.join(publicDir, 'index.html');

function readMonolithScript() {
  const parts = [
    '01-core-router-status.js',
    '02-crons-skills-agents.js',
    '03-chat-team.js',
    '04-mission-control.js',
    '05-bind-init.js',
    '06-projects.js',
  ].map((f) => fs.readFileSync(path.join(publicDir, 'assets/js', f), 'utf8').trim());
  return `${parts.join('\n\n')}\n`;
}

function main() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (html.includes('assets/js/01-core-router-status.js')) {
    console.log('index.html already uses split assets; nothing to rebuild.');
    return;
  }
  console.error('Monolith index.html rebuild not implemented — use assets/ as source of truth.');
  process.exit(1);
}

main();
