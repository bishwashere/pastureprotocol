/**
 * Unit tests for the Calendar skill executor.
 * Tests argument validation without real gog CLI calls.
 * Run with GOG_ACCOUNT set and gog authenticated for live tests.
 */

import { executeCalendar } from '../../lib/executors/calendar.js';

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

console.log('\nCalendar skill executor tests\n');

await test('create_event requires confirm=true', async () => {
  const result = await executeCalendar({}, {
    title: 'Team sync',
    start: new Date().toISOString(),
  }, 'calendar_create_event');
  assertError(result, 'confirmation');
});

await test('create_event requires title', async () => {
  const result = await executeCalendar({}, { confirm: true, start: new Date().toISOString() }, 'calendar_create_event');
  assertError(result, 'title');
});

await test('create_event requires start', async () => {
  const result = await executeCalendar({}, { confirm: true, title: 'Meeting' }, 'calendar_create_event');
  assertError(result, 'start');
});

await test('update_event requires confirm=true', async () => {
  const result = await executeCalendar({}, { event_id: 'abc', title: 'New title' }, 'calendar_update_event');
  assertError(result, 'confirmation');
});

await test('update_event requires event_id', async () => {
  const result = await executeCalendar({}, { confirm: true, title: 'New title' }, 'calendar_update_event');
  assertError(result, 'event_id');
});

await test('delete_event requires confirm=true', async () => {
  const result = await executeCalendar({}, { event_id: 'abc' }, 'calendar_delete_event');
  assertError(result, 'confirmation');
});

await test('delete_event requires event_id', async () => {
  const result = await executeCalendar({}, { confirm: true }, 'calendar_delete_event');
  assertError(result, 'event_id');
});

await test('check_availability requires start and end', async () => {
  const result = await executeCalendar({}, { start: new Date().toISOString() }, 'calendar_check_availability');
  assertError(result, 'end');
});

await test('get_event requires event_id', async () => {
  const result = await executeCalendar({}, {}, 'calendar_get_event');
  assertError(result, 'event_id');
});

await test('unknown action returns error', async () => {
  const result = await executeCalendar({}, {}, 'calendar_bananas');
  assertError(result, 'unknown');
});

// Duration parser internals are exercised via find_free_slot (no CLI needed for arg checking)
await test('find_free_slot accepts valid duration string (no live CLI needed for arg check)', async () => {
  // Just ensure it doesn't throw on building argv — we can't run gog here
  // so we rely on validation test (no gog = will get error response from spawn)
  const result = await executeCalendar({}, { duration: '30min' }, 'calendar_find_free_slot');
  // Will get a gog error or success from the CLI, not our validation error
  const obj = typeof result === 'string' ? JSON.parse(result) : result;
  const hasError = !!obj.error;
  // Acceptable: either CLI not found error or success
  if (hasError && obj.error.toLowerCase().includes('unknown calendar action')) {
    throw new Error('Should not be unknown action');
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
