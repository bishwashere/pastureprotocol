/**
 * Tests for shared credential normalization helpers.
 */

import { normalizeSelfAlias, resolveEnvCredential, resolveAccount } from '../../../../lib/util/credential-utils.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\nCredential utils tests\n');

test('normalizeSelfAlias maps @me to empty', () => {
  if (normalizeSelfAlias('@me') !== '') throw new Error('expected empty');
});

test('normalizeSelfAlias keeps real email', () => {
  if (normalizeSelfAlias('user@example.com') !== 'user@example.com') throw new Error('expected email');
});

test('resolveEnvCredential reads env var by name', () => {
  process.env.TEST_CREDENTIAL_UTILS_KEY = 'secret-value';
  try {
    if (resolveEnvCredential('TEST_CREDENTIAL_UTILS_KEY') !== 'secret-value') {
      throw new Error('expected env value');
    }
  } finally {
    delete process.env.TEST_CREDENTIAL_UTILS_KEY;
  }
});

test('resolveEnvCredential returns literal when not env name', () => {
  if (resolveEnvCredential('BSA_literal_key') !== 'BSA_literal_key') throw new Error('expected literal');
});

test('resolveAccount falls back from @me to default', () => {
  const acc = resolveAccount('@me', () => 'bishwashere@gmail.com');
  if (acc !== 'bishwashere@gmail.com') throw new Error(`expected default, got ${acc}`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
