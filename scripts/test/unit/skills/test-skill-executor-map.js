#!/usr/bin/env node
/**
 * Enforce the skill/executor -> unit-test coverage map.
 *
 * Adding a new skill or executor should fail this test until the file is mapped
 * to at least one unit test. The map also documents which cheap tests to run
 * when touching a skill or executor.
 */

import assert from 'assert';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MAP_PATH = join(ROOT, 'scripts/test/unit/skills/skill-executor-unit-map.json');

function rel(...parts) {
  return parts.join('/').replace(/\\/g, '/');
}

function listExecutorFiles() {
  const dir = join(ROOT, 'lib/agent/executors');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => rel('lib/agent/executors', name));
}

function listSkillDocs() {
  const dir = join(ROOT, 'skills');
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => rel('skills', entry.name, 'SKILL.md'))
    .filter((path) => existsSync(join(ROOT, path)))
    .sort();
}

function parseDispatcher() {
  const source = readFileSync(join(ROOT, 'skills/executor.js'), 'utf8');
  const imports = new Map();
  const importRe = /import\s+\{\s*([^}]+?)\s*\}\s+from\s+'..\/lib\/agent\/executors\/([^']+)'/g;
  let match;
  while ((match = importRe.exec(source))) {
    const importPath = rel('lib/agent/executors', match[2]);
    for (const rawName of match[1].split(',')) {
      const name = rawName.trim().split(/\s+as\s+/i).pop();
      if (name) imports.set(name, importPath);
    }
  }

  const objectMatch = source.match(/const EXECUTORS = \{([\s\S]*?)\n\};/);
  assert(objectMatch, 'skills/executor.js must define const EXECUTORS');
  const entries = new Map();
  const entryRe = /(?:'([^']+)'|([A-Za-z0-9_-]+))\s*:\s*(execute[A-Za-z0-9_]+)/g;
  while ((match = entryRe.exec(objectMatch[1]))) {
    const skillId = match[1] || match[2];
    const fnName = match[3];
    entries.set(skillId, imports.get(fnName));
  }
  return entries;
}

function assertSameSet(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expectedSet.has(item));
  assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] }, label);
}

function assertUnitTests(label, tests) {
  assert(Array.isArray(tests) && tests.length > 0, `${label} must list at least one unit test`);
  for (const testPath of tests) {
    assert(
      typeof testPath === 'string' && testPath.startsWith('scripts/test/unit/'),
      `${label} test must live under scripts/test/unit/: ${testPath}`,
    );
    assert(existsSync(join(ROOT, testPath)), `${label} mapped test does not exist: ${testPath}`);
  }
}

const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
const executorMap = map.executors || {};
const skillMap = map.skills || {};
const executorFiles = listExecutorFiles();
const skillDocs = listSkillDocs();
const dispatcher = parseDispatcher();

assertSameSet('executor map must match lib/agent/executors/*.js', Object.keys(executorMap).sort(), executorFiles);
assertSameSet('skill map must match skills/*/SKILL.md', Object.keys(skillMap).sort(), skillDocs);

for (const [executorPath, entry] of Object.entries(executorMap)) {
  assertUnitTests(executorPath, entry.unitTests);
  assert(Array.isArray(entry.skillIds), `${executorPath} must declare skillIds`);
  for (const skillId of entry.skillIds) {
    assert(dispatcher.has(skillId), `${executorPath} maps unknown dispatched skill: ${skillId}`);
    assert.strictEqual(
      dispatcher.get(skillId),
      executorPath,
      `${skillId} dispatcher target must match executor map`,
    );
  }
}

for (const [skillPath, entry] of Object.entries(skillMap)) {
  const skillId = skillPath.split('/')[1];
  assertUnitTests(skillPath, entry.unitTests);
  if (entry.executor == null) {
    assert(!dispatcher.has(skillId), `${skillPath} has no executor in map but is dispatched`);
    continue;
  }
  assert(executorMap[entry.executor], `${skillPath} references unmapped executor ${entry.executor}`);
  assert(dispatcher.has(skillId), `${skillPath} maps executor but skill is not dispatched`);
  assert.strictEqual(dispatcher.get(skillId), entry.executor, `${skillId} dispatcher target must match skill map`);
}

for (const [skillId, executorPath] of dispatcher.entries()) {
  const skillPath = rel('skills', skillId, 'SKILL.md');
  assert(skillMap[skillPath], `dispatched skill is missing from skill map: ${skillId}`);
  assert(executorMap[executorPath], `dispatched executor is missing from executor map: ${executorPath}`);
}

for (const executorPath of Object.keys(executorMap)) {
  await import(pathToFileURL(join(ROOT, executorPath)).href);
}

console.log('test-skill-executor-map passed');
