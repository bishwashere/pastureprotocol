#!/usr/bin/env node
/**
 * Per-turn skill-doc dedupe contract.
 *
 * Audit finding #22: full SKILL.md was being appended on every tool call,
 * not just the first time per turn. Multi-call skills (read called 5x,
 * memory_search + memory_get) blew up the tool-message context.
 *
 * Now there must be a `skillDocsInjected` Set in agent.js, the doc-injection
 * branch must check it, and the skill id must be added on first injection.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

const checks = [
  {
    name: 'skillDocsInjected Set is declared per turn',
    ok: /const\s+skillDocsInjected\s*=\s*new\s+Set\(\)/.test(agent),
  },
  {
    name: 'Comment references audit finding #22',
    ok: /audit finding #22/i.test(agent),
  },
  {
    name: 'getFullSkillDoc branch is gated on !skillDocsInjected.has(skillId)',
    ok: /typeof\s+getFullSkillDoc\s*===\s*['"]function['"]\s*&&\s*!skillDocsInjected\.has\(skillId\)/.test(agent),
  },
  {
    name: 'skillId is added to skillDocsInjected after injection',
    ok: /skillDocsInjected\.add\(skillId\)/.test(agent),
  },
  {
    name: 'Doc is only appended when fullDoc is truthy (existing behavior preserved)',
    ok: /if\s*\(fullDoc\)\s*\{\s*\n\s*toolContent\s*=\s*result\s*\+\s*['"]\\n\\n---\\nFull skill doc for/.test(agent),
  },
];

let failed = 0;
console.log('Skill-doc dedupe contract\n');
for (const c of checks) {
  process.stdout.write(`  ${c.name} … `);
  if (c.ok) {
    console.log('PASS');
  } else {
    console.log('FAIL');
    failed++;
  }
}

console.log('\n| Test | Status |');
console.log('| --- | --- |');
for (const c of checks) {
  console.log(`| ${c.name} | ${c.ok ? 'Pass' : 'Fail'} |`);
}

process.exit(failed ? 1 : 0);
