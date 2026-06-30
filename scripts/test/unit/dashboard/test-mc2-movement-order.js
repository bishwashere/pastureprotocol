#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '../../../../dashboard/public/assets/js/03-chat-team.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const start = source.indexOf('function buildMissionControlMovementGroups');
assert(start >= 0, 'buildMissionControlMovementGroups exists');

const end = source.indexOf('window.buildMissionControlMovementGroups', start);
assert(end > start, 'movement builder export follows function');

const body = source.slice(start, end);
assert(body.includes('pinnedGroups.forEach(appendGroup)'), 'pinned movement groups are included');
assert(body.includes('regular.forEach(function (g)'), 'regular movement groups are included');
assert(body.includes('return out.sort(function (a, b)'), 'combined movement groups are sorted before return');
assert(
  body.includes('return (Number(b.ts) || 0) - (Number(a.ts) || 0);'),
  'combined movement groups sort newest first'
);
assert(
  body.includes('}).slice(0, maxGroups);'),
  'movement groups are capped after sorting'
);

console.log('mc2 movement order tests passed');
