#!/usr/bin/env node
/**
 * Verifies the group-chat blocklist is a single source of truth and covers
 * every mutating / owner-only skill. Failures here are a security regression.
 */

import { GROUP_BLOCKED_SKILLS, executeSkill } from '../../../../skills/executor.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

const REQUIRED_BLOCKED = [
  'go-read',
  'go-write',
  'ssh-inspect',
  'agent-send',
  'write',
  'edit',
  'apply-patch',
  'home-assistant',
  'gmail',
  'calendar',
  'gog',
  'mongodb',
  'background-tasks',
  'cron',
];

for (const id of REQUIRED_BLOCKED) {
  check(`GROUP_BLOCKED_SKILLS includes "${id}"`, GROUP_BLOCKED_SKILLS.has(id));
}

const READ_ONLY_ALLOWED = ['read', 'memory', 'search', 'browse', 'me'];
for (const id of READ_ONLY_ALLOWED) {
  check(`GROUP_BLOCKED_SKILLS does NOT include read-only "${id}"`, !GROUP_BLOCKED_SKILLS.has(id));
}

const result = await executeSkill('write', { isGroup: true }, { path: 'foo', content: 'x' });
let parsed;
try {
  parsed = JSON.parse(result);
} catch {
  parsed = null;
}
check(
  'executeSkill returns blocked-error for write in a group ctx',
  parsed && typeof parsed.error === 'string' && parsed.error.includes('not available in group chats'),
  `result=${result?.slice(0, 120)}`
);

check(
  '`core` skill removed from dispatcher (loader migrates `core` to go-read/go-write)',
  JSON.parse(await executeSkill('core', { isGroup: false }, {}))?.error === 'Unknown skill: core'
);

const loader = await import('../../../../skills/loader.js');
check(
  'skills/loader.js imports the same GROUP_BLOCKED_SKILLS (no duplicate set)',
  typeof loader.getEnabledSkillIds === 'function'
);
const enabledInGroup = loader.getEnabledSkillIds({ groupJid: '__nonexistent_group_test__' });
const enabledInGroupSet = new Set(enabledInGroup);
const leakedFromGroup = REQUIRED_BLOCKED.filter((id) => enabledInGroupSet.has(id));
check(
  'Mutating/owner-only skills are NOT exposed to the LLM in groups',
  leakedFromGroup.length === 0,
  `leaked=${JSON.stringify(leakedFromGroup)}`
);

console.log(`\n[group-blocklist] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
