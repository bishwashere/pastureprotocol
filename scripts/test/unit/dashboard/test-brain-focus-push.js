#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsPath = path.join(__dirname, '../../../../dashboard/public/assets/js/02-crons-skills-agents.js');
const js = fs.readFileSync(jsPath, 'utf8');

const checks = [
  {
    name: 'Brain focus push uses a gentle near-item multiplier',
    ok: /BRAIN_FOCUS_NEAR_PUSH_MULTIPLIER\s*=\s*0\.75/.test(js),
  },
  {
    name: 'Brain focus push softens distance-based displacement',
    ok: /edgeDistance\s*\*\s*0\.42\s*\+\s*6/.test(js),
  },
  {
    name: 'Brain hover uses instant preview before dwell focus',
    ok: /BRAIN_FOCUS_DWELL_MS\s*=\s*1000/.test(js) &&
      /if \(!lockedFocus && focusTarget && focusTarget\.mode === 'word'\) \{[\s\S]{0,220}setBrainHoverPreview\(focusTarget\);/.test(js) &&
      /setTimeout\(function \(\) \{[\s\S]{0,160}applyBrainHover\(pendingHover\)[\s\S]{0,120}BRAIN_FOCUS_DWELL_MS/.test(js),
  },
  {
    name: 'Brain moving to a new word clears unlocked full focus immediately',
    ok: /function resetBrainHoverFocusImmediate\(/.test(js) &&
      /if \(currentFocus && focusTarget\.label !== currentFocus\) resetBrainHoverFocusImmediate\(\);/.test(js),
  },
  {
    name: 'Brain hover preview requires a clicked locked focus',
    ok: /previewText/.test(js) &&
      /function canPreviewBrainFocusTarget\(/.test(js) &&
      /if \(!lockedFocus\) return false;/.test(js) &&
      /if \(canPreviewBrainFocusTarget\(focusTarget\)\) \{[\s\S]{0,220}setBrainHoverPreview\(focusTarget\);[\s\S]{0,80}return;/.test(js),
  },
  {
    name: 'Brain click commits the previewed word as the main focus',
    ok: /meshCanvas\.addEventListener\('click'[\s\S]{0,900}lockedFocus = focusTarget;[\s\S]{0,220}applyBrainHover\(focusTarget\);/.test(js),
  },
  {
    name: 'Brain focus neighborhood records displacement vectors',
    ok: /candidates\[text\]\s*=\s*\{[\s\S]{0,180}dx:\s*dx,[\s\S]{0,80}dy:\s*dy/.test(js),
  },
  {
    name: 'Brain renderer applies pushed focus positions before hitboxes and drawing',
    ok: /function brainPushedFocusPositions\(/.test(js) &&
      /var positions\s*=\s*brainPushedFocusPositions\(basePositions,\s*focusNeighborhood,\s*width,\s*height\)/.test(js),
  },
  {
    name: 'Brain push keeps labels inside the canvas',
    ok: /Math\.max\(marginX,\s*Math\.min\(safeW - marginX/.test(js) &&
      /Math\.max\(marginY,\s*Math\.min\(safeH - marginY/.test(js),
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

console.log('\nBrain focus push checks passed.');
