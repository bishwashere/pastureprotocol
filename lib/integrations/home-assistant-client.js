/**
 * Shared Home Assistant API client. Used by the executor and by ha-cli.js.
 * Loads HA_URL and HA_TOKEN from environment (~/.pasture/.env when PASTURE_STATE_DIR is set).
 */

import dotenv from 'dotenv';
import { getEnvPath } from './paths.js';

const TIMEOUT_MS = 15_000;
const DEFAULT_HA_URL = 'http://localhost:8123';

/** User-facing plural domains → Home Assistant entity domains. */
const HA_DOMAIN_ALIASES = {
  lights: 'light',
  switches: 'switch',
  automations: 'automation',
  sensors: 'sensor',
  climates: 'climate',
  covers: 'cover',
  scenes: 'scene',
  scripts: 'script',
};

/**
 * @param {string} domain - e.g. "lights", "light", "sensor"
 * @returns {string}
 */
export function normalizeHaDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^\./, '');
  if (!d) return '';
  return HA_DOMAIN_ALIASES[d] || d;
}

let haEnvLoaded = false;

function ensureHaEnv() {
  if (process.env.HA_TOKEN) return;
  if (haEnvLoaded) return;
  haEnvLoaded = true;
  try {
    dotenv.config({ path: getEnvPath() });
  } catch (_) {}
}

export function getBaseUrl() {
  ensureHaEnv();
  const url = (process.env.HA_URL || DEFAULT_HA_URL).trim().replace(/\/+$/, '') || DEFAULT_HA_URL;
  const token = (process.env.HA_TOKEN || '').trim();
  if (!token) throw new Error('Home Assistant token is not set. Set HA_TOKEN (long-lived access token) in the environment.');
  return { url, token };
}

/**
 * @param {string} path - e.g. /api/states
 * @param {{ method?: string, body?: object }} [opts]
 */
export async function haFetch(path, opts = {}) {
  const { url: base, token } = getBaseUrl();
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? path : '/' + path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const init = {
    method: opts.method || 'GET',
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (opts.body != null && (opts.method === 'POST' || opts.method === 'PUT')) {
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    let hint = 'Check that Home Assistant is running and reachable at that URL.';
    if (/ECONNREFUSED|connection refused/i.test(msg)) {
      hint = 'Connection refused — is Home Assistant running? If HA is on another machine, set HA_URL in ~/.pasture/.env and restart.';
    } else if (/ENOTFOUND|getaddrinfo|Unknown host/i.test(msg)) {
      hint = 'Host not found — set the correct HA_URL in ~/.pasture/.env and restart.';
    } else if (/fetch failed|network|timeout|ETIMEDOUT/i.test(msg)) {
      hint = 'Network or timeout error — set HA_URL in ~/.pasture/.env and restart.';
    }
    throw new Error(`Cannot reach Home Assistant at ${base}: ${msg}. ${hint}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Home Assistant API ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * List entities, optionally filtered by domain (e.g. light, automation, switch).
 * @param {string} [domain] - Optional domain to filter (e.g. "light", "automation").
 * @returns {Promise<object>} { message, entities, total }
 */
export async function listStates(domain = '') {
  const data = await haFetch('/api/states');
  const list = Array.isArray(data) ? data : [];
  let filtered = list;
  const normalizedDomain = normalizeHaDomain(domain);
  if (normalizedDomain) {
    filtered = list.filter((s) => s && String(s.entity_id || '').startsWith(normalizedDomain + '.'));
  }
  if (filtered.length === 0) {
    return {
      message: normalizedDomain ? `No entities in domain "${normalizedDomain}".` : 'No entities returned.',
      entities: [],
      total: 0,
    };
  }
  const summary = filtered.slice(0, 100).map((s) => ({
    entity_id: s.entity_id,
    state: s.state,
    attributes: s.attributes ? { friendly_name: s.attributes.friendly_name } : {},
  }));
  return {
    message: `Found ${filtered.length} entity(ies)${normalizedDomain ? ` in domain "${normalizedDomain}"` : ''}.`,
    entities: summary,
    total: filtered.length,
  };
}

/**
 * Search entities by name (friendly_name or entity_id).
 * @param {string} query - Search string (e.g. "kitchen", "thermostat").
 * @returns {Promise<object>} { message, entities, total }
 */
export async function searchEntities(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    return { message: 'Provide a search term (e.g. kitchen, thermostat).', entities: [], total: 0 };
  }
  const data = await haFetch('/api/states');
  const list = Array.isArray(data) ? data : [];
  const filtered = list.filter((s) => {
    if (!s) return false;
    const id = String(s.entity_id || '').toLowerCase();
    const name = (s.attributes && s.attributes.friendly_name) ? String(s.attributes.friendly_name).toLowerCase() : '';
    return id.includes(q) || name.includes(q);
  });
  const summary = filtered.slice(0, 50).map((s) => ({
    entity_id: s.entity_id,
    state: s.state,
    attributes: s.attributes ? { friendly_name: s.attributes.friendly_name } : {},
  }));
  return {
    message: filtered.length ? `Found ${filtered.length} matching "${query}".` : `No entities matching "${query}".`,
    entities: summary,
    total: filtered.length,
  };
}

/**
 * Get one entity's state.
 * @param {string} entityId - e.g. light.living_room
 * @returns {Promise<object>} { entity_id, state, attributes }
 */
export async function getState(entityId) {
  const id = String(entityId || '').trim();
  if (!id) throw new Error('get_state requires an entity_id (e.g. light.living_room).');
  const encoded = id.split('.').map((s) => encodeURIComponent(s)).join('.');
  const data = await haFetch(`/api/states/${encoded}`);
  if (data == null) throw new Error(`Entity ${entityId} not found.`);
  return {
    entity_id: data.entity_id,
    state: data.state,
    attributes: data.attributes || {},
  };
}

/**
 * Call a Home Assistant service.
 * @param {string} domain - e.g. light, script, automation
 * @param {string} service - e.g. turn_on, trigger
 * @param {string} [entityId] - Optional entity_id
 * @param {object} [serviceData] - Optional extra payload
 * @returns {Promise<object>} { message, result }
 */
export async function callService(domain, service, entityId = null, serviceData = {}) {
  const d = String(domain || '').trim();
  const s = String(service || '').trim();
  if (!d || !s) throw new Error('call_service requires domain and service (e.g. domain: light, service: turn_on).');
  const body = typeof serviceData === 'object' && serviceData ? { ...serviceData } : {};
  if (entityId != null) body.entity_id = entityId;
  const url = `/api/services/${encodeURIComponent(d)}/${encodeURIComponent(s)}`;
  const data = await haFetch(url, { method: 'POST', body });
  return {
    message: `Called ${d}.${s}${entityId ? ` on ${entityId}` : ''}.`,
    result: data,
  };
}
