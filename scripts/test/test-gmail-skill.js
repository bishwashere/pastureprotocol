/**
 * Unit tests for the Gmail skill executor.
 * Tests argument validation without real gog CLI calls.
 * Run with GOG_ACCOUNT set and gog authenticated for live tests.
 */

import { executeGmail } from '../../lib/executors/gmail.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assertError(result, partialMsg) {
  const obj = typeof result === 'string' ? JSON.parse(result) : result;
  if (!obj.error) throw new Error('Expected an error response');
  if (partialMsg && !obj.error.toLowerCase().includes(partialMsg.toLowerCase())) {
    throw new Error(`Expected error containing "${partialMsg}", got: ${obj.error}`);
  }
}

console.log('\nGmail skill executor tests\n');

await test('send_email requires confirm=true', async () => {
  const result = await executeGmail({}, {
    to: 'test@example.com',
    subject: 'Hello',
    body: 'Hi there',
    confirm: false,
  }, 'gmail_send_email');
  assertError(result, 'confirmation');
});

await test('send_email requires to, subject, body', async () => {
  const result = await executeGmail({}, {
    to: 'test@example.com',
    confirm: true,
  }, 'gmail_send_email');
  assertError(result, 'subject');
});

await test('reply_email requires confirm=true', async () => {
  const result = await executeGmail({}, { id: 'abc123', body: 'OK' }, 'gmail_reply_email');
  assertError(result, 'confirmation');
});

await test('read_email requires id', async () => {
  const result = await executeGmail({}, {}, 'gmail_read_email');
  assertError(result, 'id');
});

await test('search_inbox requires query', async () => {
  const result = await executeGmail({}, {}, 'gmail_search_inbox');
  assertError(result, 'query');
});

await test('archive without ids or query returns error', async () => {
  const result = await executeGmail({}, {}, 'gmail_archive');
  assertError(result, 'ids or query');
});

await test('trash without ids or query returns error', async () => {
  const result = await executeGmail({}, {}, 'gmail_trash');
  assertError(result, 'ids or query');
});

await test('unknown action returns error', async () => {
  const result = await executeGmail({}, {}, 'gmail_banana');
  assertError(result, 'unknown');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
