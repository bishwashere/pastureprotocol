#!/usr/bin/env node
/**
 * Final reply policy stays generic, while skill docs own domain/tool-specific
 * guidance such as how to answer Brain graph questions.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const policy = readFileSync(join(root, 'lib/agent/templates/final-reply-policy.md'), 'utf8');
const memorySkill = readFileSync(join(root, 'skills/memory/SKILL.md'), 'utf8');
const goReadSkill = readFileSync(join(root, 'skills/go-read/SKILL.md'), 'utf8');
const selfInspectionClassifier = readFileSync(join(root, 'lib/agent/templates/self-inspection-classifier.md'), 'utf8');
const turnRouter = readFileSync(join(root, 'lib/agent/templates/turn-router-prompt.md'), 'utf8');

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
    ok: goReadSkill.includes('top Brain items/words/nodes/terms') &&
      goReadSkill.includes('Use generic read steps instead') &&
      goReadSkill.includes('/api/brain/cloud') &&
      goReadSkill.includes('payload.terms[].text') &&
      goReadSkill.includes('prefer larger files') &&
      goReadSkill.includes('Brain cache filenames are usually hashes') &&
      goReadSkill.includes('never invent a cache filename') &&
      goReadSkill.includes('do not declare the data unavailable just because one cache file has empty arrays') &&
      goReadSkill.includes('Do not invent a proxy list from chunks'),
  },
  {
    name: 'go-read treats primary values as main data',
    ok: goReadSkill.includes('For structured reads, treat primary values as the main data') &&
      goReadSkill.includes('text, label, name, title, term, word, phrase, content, weight, score, rank, count, and frequency') &&
      goReadSkill.includes('ids, paths, line numbers, chunk ids, embeddings, vectors') &&
      goReadSkill.includes('Prefer **json** over **cat** for JSON cache/API response files') &&
      goReadSkill.includes('do not present it as the answer'),
  },
  {
    name: 'memory skill rejects chunk/file/id/length proxies',
    ok: /Do not answer with chat-log paths[\s\S]{0,120}internal IDs[\s\S]{0,80}chunk lengths[\s\S]{0,80}raw stopword frequency/i.test(memorySkill),
  },
  {
    name: 'router prompts preserve short grounded follow-ups',
    ok: selfInspectionClassifier.includes('normal work done with a skill or project') &&
      selfInspectionClassifier.includes('diagnose Pasture/CowCode behavior') &&
      turnRouter.includes('Use recent conversation to resolve short follow-ups') &&
      turnRouter.includes('rather than treating it as casual chat'),
  },
  {
    name: 'router prompts keep implementation turns write-capable',
    ok: selfInspectionClassifier.includes('writing, editing, cloning') &&
      turnRouter.includes('Code and file implementation') &&
      turnRouter.includes('apply patches') &&
      turnRouter.includes('write`, `edit`, `go-write`, or `apply-patch`'),
  },
  {
    name: 'final policy prevents ungrounded progress claims',
    ok: policy.includes('Do not claim that code was written') &&
      policy.includes('no write-capable tool was available in this turn') &&
      policy.includes('current turn did not expose write tools'),
  },
  {
    name: 'final policy suppresses internal tool payloads',
    ok: policy.includes('Never include internal tool invocations') &&
      policy.includes('tool-call JSON') &&
      policy.includes('patch-application payloads') &&
      policy.includes('action was not completed'),
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
