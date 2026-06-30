/**
 * Unit tests for Home Assistant natural-language formatting.
 */

import { describeEntityState, enrichHaToolResult, friendlyLabel } from '../../../../lib/integrations/home-assistant-format.js';
import { normalizeHaDomain } from '../../../../lib/integrations/home-assistant-client.js';

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

console.log('\nHome Assistant format tests\n');

test('normalizeHaDomain maps lights → light', () => {
  if (normalizeHaDomain('lights') !== 'light') throw new Error('lights alias failed');
  if (normalizeHaDomain('sensor') !== 'sensor') throw new Error('sensor unchanged');
  if (normalizeHaDomain('sensors') !== 'sensor') throw new Error('sensors alias failed');
});

test('friendlyLabel prefers friendly_name over entity_id', () => {
  const label = friendlyLabel({
    entity_id: 'sensor.dining_room_temperature',
    attributes: { friendly_name: 'Dining Room' },
  });
  if (label !== 'Dining Room') throw new Error(`got ${label}`);
});

test('describeEntityState formats weather naturally', () => {
  const line = describeEntityState({
    entity_id: 'weather.forecast_home',
    state: 'sunny',
    attributes: { friendly_name: 'Forecast Home', temperature: 72, temperature_unit: '°F' },
  });
  if (!line.includes('72°F')) throw new Error(`missing temp: ${line}`);
  if (!/sunny/i.test(line)) throw new Error(`missing condition: ${line}`);
  if (line.includes('weather.forecast')) throw new Error(`exposed entity_id: ${line}`);
});

test('describeEntityState rounds sensor temperature', () => {
  const line = describeEntityState({
    entity_id: 'sensor.dining_room_temperature',
    state: '73.58',
    attributes: { friendly_name: 'Dining Room', unit_of_measurement: '°F' },
  });
  if (!line.includes('74°F')) throw new Error(`expected rounded temp: ${line}`);
});

test('enrichHaToolResult adds summary and reply_hint for state', () => {
  const raw = JSON.stringify({
    entity_id: 'sensor.dining_room_temperature',
    state: '73.58',
    attributes: { friendly_name: 'Dining Room', unit_of_measurement: '°F' },
  });
  const out = JSON.parse(enrichHaToolResult(raw));
  if (!out.summary) throw new Error('missing summary');
  if (!out.reply_hint) throw new Error('missing reply_hint');
  if (out.summary.includes('sensor.')) throw new Error('summary contains entity_id');
});

test('enrichHaToolResult humanizes turn_on message', () => {
  const raw = JSON.stringify({ message: 'Called light.turn_on on light.living_room.' });
  const out = JSON.parse(enrichHaToolResult(raw));
  if (!/turned on/i.test(out.summary)) throw new Error(`expected turned on: ${out.summary}`);
  if (out.summary.includes('light.living_room')) throw new Error('entity_id in summary');
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
