#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const loader = read('dashboard/public/assets/js/00-loader.js');
const router = read('dashboard/public/assets/js/01-core-router-status.js');
const nav = read('dashboard/public/assets/partials/nav.html');
const brainJs = read('dashboard/public/assets/js/02-crons-skills-agents.js');
const css = read('dashboard/public/assets/css/dashboard.css');
const html = read('dashboard/public/index.html');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

['brain1', 'brain2', 'brain3'].forEach((id) => {
  const page = read(`dashboard/public/pages/${id}.html`);
  assert(loader.includes(`'${id}'`), `${id} is loaded as a page fragment`);
  assert(router.includes(`'${id}'`), `${id} is accepted by the router`);
  assert(nav.includes(`href="/${id}"`) && nav.includes(`data-page="${id}"`), `${id} has a nav route`);
  assert(page.includes(`id="page-${id}"`) && page.includes(`id="${id}-cloud"`), `${id} page has separate canvas targets`);
  assert(page.includes(`id="${id}-refresh"`), `${id} page has its own Generate button`);
});

assert(brainJs.includes('var BRAIN_VARIANTS = {'), 'variant configs are defined');
assert(brainJs.includes("brain1: { name: 'Lens cloud'"), 'Brain 1 is the lens design');
assert(brainJs.includes("brain2: { name: 'Orbit cloud'"), 'Brain 2 is the orbit design');
assert(brainJs.includes("brain3: { name: 'Compare cloud'"), 'Brain 3 is the compare design');
assert(brainJs.includes('window.fetchBrainVariantCloud = fetchBrainVariantCloud'), 'variant fetcher is globally routable');
assert(brainJs.includes("config.mode === 'orbit'"), 'orbit variant changes the layout model');
assert(brainJs.includes("config.mode === 'compare'"), 'compare variant enables two-word relationship state');
assert(css.includes('.brain-variant-stage') && css.includes('#page-brain2 .brain-variant-cloud'), 'variant CSS is scoped');
assert(html.includes('assets/js/00-loader.js?v=4'), 'loader cachebuster was bumped');
assert(html.includes('assets/js/01-core-router-status.js?v=9'), 'router cachebuster was bumped');
assert(html.includes('assets/js/02-crons-skills-agents.js?v=45'), 'brain JS cachebuster was bumped');
assert(html.includes('assets/css/dashboard.css?v=57'), 'dashboard CSS cachebuster was bumped');

console.log('brain variant route checks passed');
