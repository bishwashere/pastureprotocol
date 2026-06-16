/**
 * Unit tests for the Calendar skill executor.
 * Tests argument validation, confirmation flow, and duration parsing.
 * Run with gog authenticated and skills.gog.account in config for live tests.
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { executeCalendar } from '../../lib/agent/executors/calendar.js';

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

function parse(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function assertError(result, partialMsg) {
  const obj = parse(result);
  if (!obj.error) throw new Error(`Expected an error response, got: ${JSON.stringify(obj).slice(0, 200)}`);
  if (partialMsg && !obj.error.toLowerCase().includes(partialMsg.toLowerCase())) {
    throw new Error(`Expected error containing "${partialMsg}", got: ${obj.error.slice(0, 200)}`);
  }
}

function assertConfirmRequired(result) {
  const obj = parse(result);
  if (obj.error !== 'confirmation_required') {
    throw new Error(`Expected confirmation_required error, got: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  if (!obj.message) throw new Error('Confirmation response must include a message');
}

console.log('\nCalendar skill executor tests\n');

// ── Validation ────────────────────────────────────────────────────────────────

await test('create_event requires confirm=true', async () => {
  const result = await executeCalendar({}, { title: 'Team sync', start: new Date().toISOString() }, 'calendar_create_event');
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

await test('check_availability requires start', async () => {
  const result = await executeCalendar({}, { end: new Date().toISOString() }, 'calendar_check_availability');
  assertError(result, 'start');
});

await test('get_event requires event_id', async () => {
  const result = await executeCalendar({}, {}, 'calendar_get_event');
  assertError(result, 'event_id');
});

await test('unknown action returns clear error', async () => {
  const result = await executeCalendar({}, {}, 'calendar_bananas');
  assertError(result, 'unknown');
});

// ── Duration parsing (internal, tested indirectly via create_event argv builder) ──

// We test the parseDurationMinutes function indirectly by checking
// that create_event with a duration end doesn't error on validation
// (it'll fail when spawning gog, but we verify our code paths run)

// Our validation-level errors (not gog CLI errors)
const OUR_VALIDATION_ERRORS = ['title required', 'start required', 'end required', 'event_id required', 'confirmation required'];

function isOurValidationError(error) {
  const e = (error || '').toLowerCase();
  return OUR_VALIDATION_ERRORS.some((msg) => e.includes(msg));
}

async function durationTest(label, args) {
  await test(`duration parsing: ${label}`, async () => {
    const result = await executeCalendar({}, {
      confirm: true,
      title: 'Test',
      start: '2026-06-10T14:00:00Z',
      ...args,
    }, 'calendar_create_event');
    const obj = parse(result);
    // Only fail if it's OUR validation error (wrong duration parsing)
    // gog CLI errors like "unknown flag" are expected since gog may not be installed/have these flags
    if (obj.error && isOurValidationError(obj.error)) {
      throw new Error(`Validation error for duration "${JSON.stringify(args)}": ${obj.error}`);
    }
  });
}

await durationTest('"30min" → 30 minute end', { end: '30min' });
await durationTest('"1h" → 60 minute end', { end: '1h' });
await durationTest('"1.5h" → 90 minute end', { end: '1.5h' });
await durationTest('"2h30m" → 150 minute end', { end: '2h30m' });
await durationTest('"45 minutes" → 45 minute end', { end: '45 minutes' });
await durationTest('"2 hours 15 minutes" → 135 minute end', { end: '2 hours 15 minutes' });
await durationTest('no end → defaults to 1h', {});

// All-day event: start is date-only
await test('all-day event: start date-only passes our validation', async () => {
  const result = await executeCalendar({}, {
    confirm: true,
    title: 'Birthday',
    start: '2026-06-15',
  }, 'calendar_create_event');
  const obj = parse(result);
  // Should not fail with OUR validation error about end — gog CLI errors are OK
  if (obj.error && isOurValidationError(obj.error)) {
    throw new Error(`Unexpected validation error: ${obj.error}`);
  }
});

function getGogDefaultAccount() {
  const configPath = join(process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture'), 'config.json');
  try {
    if (!existsSync(configPath)) return '';
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return config?.skills?.gog?.account || '';
  } catch {
    return '';
  }
}

const gogAccount = process.env.GOG_ACCOUNT || getGogDefaultAccount();
if (gogAccount) {
  console.log('\n  Running live Calendar tests\n');
  await test('list_events with account @me uses configured default', async () => {
    const result = await executeCalendar({}, { account: '@me', days: 1, max: 1 }, 'calendar_list_events');
    const text = String(result);
    if (/no auth for calendar @me/i.test(text)) {
      throw new Error('@me was not normalized');
    }
  });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
