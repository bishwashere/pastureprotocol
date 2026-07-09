#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../../../../');
const brainHtml = fs.readFileSync(path.join(root, 'dashboard/public/pages/brain.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'dashboard/public/assets/css/dashboard.css'), 'utf8');
const brainJs = fs.readFileSync(path.join(root, 'dashboard/public/assets/js/02-crons-skills-agents.js'), 'utf8');
const coreJs = fs.readFileSync(path.join(root, 'dashboard/public/assets/js/01-core-router-status.js'), 'utf8');

const checks = [
  {
    name: 'Brain page exposes fullscreen enter and exit controls',
    ok: brainHtml.includes('id="brain-fullscreen-toggle"') &&
      brainHtml.includes('id="brain-fullscreen-exit"'),
  },
  {
    name: 'Fullscreen mode hides Pasture chrome and Brain toolbar',
    ok: /body\.brain-fullscreen-mode[\s\S]{0,600}dashboard-ascii-logo/.test(css) &&
      /body\.brain-fullscreen-mode[\s\S]{0,600}#dashboard-nav-root/.test(css) &&
      /body\.brain-fullscreen-mode[\s\S]{0,600}\.brain-toolbar/.test(css),
  },
  {
    name: 'Fullscreen mode lets the Brain canvas fill the viewport',
    ok: /body\.brain-fullscreen-mode #page-brain\.active[\s\S]{0,220}height:\s*100dvh/.test(css) &&
      /body\.brain-fullscreen-mode \.brain-stage[\s\S]{0,240}grid-template-rows:\s*1fr/.test(css) &&
      /body\.brain-fullscreen-mode \.brain-cloud[\s\S]{0,120}height:\s*100%/.test(css),
  },
  {
    name: 'Brain fullscreen toggles redraw and Escape exit',
    ok: /function setBrainFullscreenMode\(on\)/.test(brainJs) &&
      /window\.setBrainFullscreenMode\s*=\s*setBrainFullscreenMode/.test(brainJs) &&
      /event\.key === 'Escape'[\s\S]{0,160}setBrainFullscreenMode\(false\)/.test(brainJs),
  },
  {
    name: 'Navigating away from Brain exits fullscreen mode',
    ok: /name !== 'brain'[\s\S]{0,120}setBrainFullscreenMode\(false\)/.test(coreJs),
  },
];

let failed = 0;
for (const check of checks) {
  const status = check.ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${check.name}`);
  if (!check.ok) failed++;
}

if (failed) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}

console.log('\nBrain fullscreen checks passed.');
