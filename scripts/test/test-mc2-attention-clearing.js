#!/usr/bin/env node
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, '../../dashboard/public/assets/js/mc2/04-mc2-home.js'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(source.includes('function mc2ProposedSuggestedTaskNeedsApproval'), 'attention helper exists');
assert(source.includes("status === 'rejected' || status === 'completed' || status === 'accepted'"), 'finished suggestedTasks clear attention');
assert(source.includes('suggestedTaskIsOnMission(suggestedTask)'), 'tasks already on missions clear proposal attention');
assert(source.includes("return status === 'proposed' || status === 'open'"), 'only open proposals need attention');
assert(source.includes('mc2ProposedSuggestedTaskNeedsApproval(it)'), 'collector uses attention helper');
assert(source.includes("it.kind === 'task' && String(it.status || '').toLowerCase() === 'doing'"), 'ETA counts in-progress tasks only');
assert(source.includes("' task' + (runningTasks.length === 1 ? '' : 's')"), 'ETA label uses task count not missions');

console.log('mc2 attention clearing tests passed');
