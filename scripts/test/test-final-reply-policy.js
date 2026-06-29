#!/usr/bin/env node
/**
 * Final reply policy stays generic, while skill docs own domain/tool-specific
 * guidance such as how to answer Brain graph questions.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const policy = readFileSync(join(root, 'lib/agent/templates/final-reply-policy.md'), 'utf8');
const memorySkill = readFileSync(join(root, 'skills/memory/SKILL.md'), 'utf8');
const goReadSkill = readFileSync(join(root, 'skills/go-read/SKILL.md'), 'utf8');

const checks = [
  {
    name: 'final policy has generic metadata extraction rule',
    ok: policy.includes('internal identifiers') &&
      policy.includes('lengths') &&
      policy.includes('JSON envelopes') &&
      policy.includes('Extract the user-facing value'),
  },
  {
    name: 'final policy does not contain Brain-specific top-item rule',
    ok: !/top brain items|brain words|denseTerms\[\]\.text/i.test(policy),
  },
  {
    name: 'memory skill maps brain item requests to graph labels',
    ok: memorySkill.includes('Brain item / word questions') &&
      memorySkill.includes('final display labels from the Brain graph') &&
      memorySkill.includes('terms[].text') &&
      memorySkill.includes('denseTerms[].text'),
  },
  {
    name: 'go-read avoids chunk/id/length proxies for top Brain terms',
    ok: /top Brain items\/words\/nodes\/terms[\s\S]{0,200}not raw memory chunks[\s\S]{0,200}text length[\s\S]{0,200}terms\[\]\.text[\s\S]{0,80}denseTerms\[\]\.text/i.test(goReadSkill),
  },
  {
    name: 'memory skill rejects chunk/file/id/length proxies',
    ok: /Do not answer with chat-log paths[\s\S]{0,120}internal IDs[\s\S]{0,80}chunk lengths[\s\S]{0,80}raw stopword frequency/i.test(memorySkill),
  },
];

let failed = 0;
console.log('Final reply policy contract\n');
for (const check of checks) {
  process.stdout.write(`  ${check.name} ... `);
  if (check.ok) {
    console.log('PASS');
  } else {
    console.log('FAIL');
    failed++;
  }
}

process.exit(failed ? 1 : 0);
