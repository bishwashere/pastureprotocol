#!/usr/bin/env node
/**
 * Home Assistant CLI. Run from project root with PASTURE_STATE_DIR set so .env is found.
 * Usage:
 *   node ha-cli.js list [domain]       e.g. list lights, list automation
 *   node ha-cli.js search <query>      e.g. search kitchen
 *   node ha-cli.js state <entity_id>   e.g. state light.living_room
 *   node ha-cli.js on <entity_id> [brightness]
 *   node ha-cli.js off <entity_id>
 *   node ha-cli.js toggle <entity_id>
 *   node ha-cli.js scene <entity_id>
 *   node ha-cli.js script <entity_id>
 *   node ha-cli.js automation <entity_id>   (triggers the automation)
 *   node ha-cli.js climate <entity_id> <temperature>
 *   node ha-cli.js call <domain> <service> [entity_id] [json_service_data]
 */

import { listStates, searchEntities, getState, callService } from '../../lib/home-assistant-client.js';

const args = process.argv.slice(2);
const sub = (args[0] || '').toLowerCase();
const rest = args.slice(1);

function out(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  try {
    if (sub === 'list') {
      const domain = (rest[0] || '').trim() || '';
      const result = await listStates(domain);
      out(result);
      return;
    }
    if (sub === 'search') {
      const query = rest[0] || '';
      const result = await searchEntities(query);
      out(result);
      return;
    }
    if (sub === 'state') {
      const entityId = rest[0] || '';
      const result = await getState(entityId);
      out(result);
      return;
    }
    if (sub === 'on') {
      const entityId = rest[0] || '';
      const brightness = rest[1] ? parseInt(rest[1], 10) : undefined;
      if (!entityId) throw new Error('Usage: on <entity_id> [brightness 0-255]');
      const domain = entityId.split('.')[0] || 'light';
      const data = brightness >= 0 && brightness <= 255 ? { brightness: Math.round(brightness) } : {};
      const result = await callService(domain, 'turn_on', entityId, data);
      out(result);
      return;
    }
    if (sub === 'off') {
      const entityId = rest[0] || '';
      if (!entityId) throw new Error('Usage: off <entity_id>');
      const domain = entityId.split('.')[0] || 'light';
      const result = await callService(domain, 'turn_off', entityId);
      out(result);
      return;
    }
    if (sub === 'toggle') {
      const entityId = rest[0] || '';
      if (!entityId) throw new Error('Usage: toggle <entity_id>');
      const domain = entityId.split('.')[0] || 'light';
      const result = await callService(domain, 'toggle', entityId);
      out(result);
      return;
    }
    if (sub === 'scene') {
      const entityId = rest[0] || '';
      if (!entityId) throw new Error('Usage: scene <entity_id>');
      const result = await callService('scene', 'turn_on', entityId);
      out(result);
      return;
    }
    if (sub === 'script') {
      const entityId = rest[0] || '';
      if (!entityId) throw new Error('Usage: script <entity_id>');
      const result = await callService('script', 'turn_on', entityId);
      out(result);
      return;
    }
    if (sub === 'automation') {
      const entityId = rest[0] || '';
      if (!entityId) throw new Error('Usage: automation <entity_id>');
      const result = await callService('automation', 'trigger', entityId);
      out(result);
      return;
    }
    if (sub === 'climate') {
      const entityId = rest[0] || '';
      const temp = rest[1] ? parseFloat(rest[1]) : NaN;
      if (!entityId) throw new Error('Usage: climate <entity_id> <temperature>');
      const result = await callService('climate', 'set_temperature', entityId, isNaN(temp) ? {} : { temperature: temp });
      out(result);
      return;
    }
    if (sub === 'call') {
      const domain = rest[0] || '';
      const service = rest[1] || '';
      const entityId = rest[2] || undefined;
      let serviceData = {};
      if (rest[3]) {
        try {
          serviceData = JSON.parse(rest[3]);
        } catch (_) {
          throw new Error('Fourth argument must be JSON object for service_data');
        }
      }
      if (!domain || !service) throw new Error('Usage: call <domain> <service> [entity_id] [json_service_data]');
      const result = await callService(domain, service, entityId, serviceData);
      out(result);
      return;
    }
    if (sub === 'help' || sub === '-h' || sub === '--help' || !sub) {
      out({
        message: 'Home Assistant CLI. Set HA_TOKEN (and optionally HA_URL) in ~/.pasture/.env or set PASTURE_STATE_DIR.',
        commands: {
          list: 'list [domain]  — list entities, e.g. list lights, list automation',
          search: 'search <query>  — find entities by name, e.g. search kitchen',
          state: 'state <entity_id>  — get one entity state',
          on: 'on <entity_id> [brightness]  — turn on light/switch',
          off: 'off <entity_id>  — turn off',
          toggle: 'toggle <entity_id>',
          scene: 'scene <entity_id>  — activate scene',
          script: 'script <entity_id>  — run script',
          automation: 'automation <entity_id>  — trigger automation',
          climate: 'climate <entity_id> <temperature>  — set thermostat',
          call: 'call <domain> <service> [entity_id] [json]  — raw service call',
        },
      });
      return;
    }
    throw new Error(`Unknown command: ${sub}. Use: list, search, state, on, off, toggle, scene, script, automation, climate, call`);
  } catch (err) {
    out({ error: err.message || String(err) });
    process.exitCode = 1;
  }
}

main();
