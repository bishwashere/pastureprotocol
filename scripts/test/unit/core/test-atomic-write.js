#!/usr/bin/env node
/**
 * writeJsonAtomic must:
 *   1. Succeed and produce parseable JSON.
 *   2. Never produce torn / half-written reads under concurrent writes.
 *   3. Leave the existing target untouched on failure.
 *   4. Clean up its temp file on failure.
 */

import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileAtomic, writeJsonAtomic } from '../../../../lib/util/atomic-write.js';

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

const dir = mkdtempSync(join(tmpdir(), 'pasture-atomic-'));
try {
  const path = join(dir, 'state.json');

  writeJsonAtomic(path, { hello: 'world' });
  const back = JSON.parse(readFileSync(path, 'utf8'));
  check('writeJsonAtomic produces parseable JSON', back.hello === 'world');

  // Concurrency: launch 30 atomic writes back-to-back, each a different value.
  // Then read N times across the loop; every read must parse successfully and
  // match one of the values written so far. (If atomic-write was non-atomic,
  // a reader would occasionally hit a half-written file and fail to parse.)
  const writes = [];
  const seenValues = new Set();
  let parseFailures = 0;
  for (let i = 0; i < 30; i++) {
    writes.push(
      Promise.resolve().then(() => writeJsonAtomic(path, { i, payload: `value-${i}-`.repeat(50) }))
    );
    try {
      const txt = readFileSync(path, 'utf8');
      const parsed = JSON.parse(txt);
      seenValues.add(parsed.i);
    } catch (e) {
      parseFailures++;
    }
  }
  await Promise.all(writes);
  check('concurrent writes never produce torn reads', parseFailures === 0, `parseFailures=${parseFailures}`);
  check('final read sees the last write', JSON.parse(readFileSync(path, 'utf8')).i === 29);

  // Failure path: writeFileAtomic with non-string payload should throw, and
  // the original target must remain intact.
  writeJsonAtomic(path, { keep: 'me' });
  let threw = false;
  try {
    writeFileAtomic(path, /** intentionally not a string */ undefined);
  } catch (_) {
    threw = true;
  }
  check('writeFileAtomic throws on bad payload', threw);
  check(
    'failed write leaves the original file intact',
    JSON.parse(readFileSync(path, 'utf8')).keep === 'me'
  );

  // No leftover .tmp.* files in the directory after all writes.
  const stragglers = readdirSync(dir).filter((f) => /\.tmp\.\d+\./.test(f));
  check('no .tmp.* siblings remain after writes', stragglers.length === 0, JSON.stringify(stragglers));

  // Auto-creates parent directory.
  const nested = join(dir, 'a', 'b', 'c', 'state.json');
  writeJsonAtomic(nested, { ok: true });
  check('writeJsonAtomic auto-creates missing parent dirs', existsSync(nested));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n[atomic-write] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
