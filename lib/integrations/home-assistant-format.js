/**
 * Turn Home Assistant JSON into human-readable summaries for the LLM and user.
 */

function humanizeEntityId(entityId) {
  const slug = String(entityId || '').split('.').slice(1).join(' ');
  if (!slug) return 'Device';
  return slug
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export function friendlyLabel(entity) {
  const name = entity?.attributes?.friendly_name;
  if (name && String(name).trim()) return String(name).trim();
  if (entity?.entity_id) return humanizeEntityId(entity.entity_id);
  return 'Device';
}

function roundTemperature(value, unit) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return null;
  const rounded = Math.round(n);
  const u = String(unit || '').trim();
  if (u === '°F' || u === '°C' || u === 'F' || u === 'C') {
    const sym = u.startsWith('°') ? u : `°${u.toUpperCase()}`;
    return `${rounded}${sym}`;
  }
  if (u) return `${rounded} ${u}`;
  return String(rounded);
}

function cleanCondition(text) {
  return String(text || '')
    .replace(/_/g, ' ')
    .trim();
}

/**
 * One-line natural description of an entity state (no entity_id).
 * @param {{ entity_id?: string, state?: string, attributes?: object }} entity
 * @returns {string}
 */
export function describeEntityState(entity) {
  if (!entity || typeof entity !== 'object') return '';
  const id = String(entity.entity_id || '');
  const domain = id.split('.')[0] || '';
  const attrs = entity.attributes || {};
  const label = friendlyLabel(entity);
  const state = entity.state;

  if (domain === 'weather') {
    const temp = attrs.temperature ?? attrs.temp ?? null;
    const unit = attrs.temperature_unit || attrs.unit_of_measurement || '°F';
    const condition = cleanCondition(
      typeof state === 'string' && Number.isNaN(parseFloat(state)) ? state : attrs.condition,
    );
    const t = temp != null ? roundTemperature(temp, unit) : null;
    if (t && condition) return `${label}: ${t}, ${condition}`;
    if (t) return `${label}: ${t}`;
    if (condition) return `${label}: ${condition}`;
  }

  if (domain === 'sensor') {
    const unit = attrs.unit_of_measurement || '';
    if (/temp|°|F|C/i.test(unit) || /temperature/i.test(id)) {
      const t = roundTemperature(state, unit);
      if (t) return `${label}: ${t}`;
    }
    if (unit) return `${label}: ${state} ${unit}`.trim();
  }

  if (domain === 'climate') {
    const temp = attrs.current_temperature ?? attrs.temperature ?? state;
    const unit = attrs.temperature_unit || attrs.unit_of_measurement || '°F';
    const t = roundTemperature(temp, unit);
    if (t) return `${label}: ${t}`;
  }

  if (domain === 'light' || domain === 'switch' || domain === 'binary_sensor') {
    const s = String(state || '').toLowerCase();
    if (s === 'on') return `${label} is on`;
    if (s === 'off') return `${label} is off`;
    if (s === 'open') return `${label} is open`;
    if (s === 'closed') return `${label} is closed`;
  }

  if (state != null && String(state).trim()) {
    return `${label}: ${state}`;
  }
  return label;
}

function humanizeServiceMessage(message) {
  const msg = String(message || '').trim();
  const called = msg.match(/^Called ([a-z_]+)\.([a-z_]+)(?: on ([a-z0-9_.]+))?\.?$/i);
  if (!called) return msg;
  const service = called[2];
  const target = called[3] ? friendlyLabel({ entity_id: called[3] }) : 'the device';
  if (service === 'turn_on') return `Turned on ${target}.`;
  if (service === 'turn_off') return `Turned off ${target}.`;
  if (service === 'toggle') return `Toggled ${target}.`;
  if (service === 'trigger') return `Ran ${target}.`;
  return msg.replace(called[3] || '', target).replace(/Called [^.]+\./, '');
}

/**
 * Add summary field(s) to HA CLI JSON for the LLM. Keeps raw data for debugging but
 * steers replies toward natural language.
 * @param {string} rawJson
 * @returns {string}
 */
export function enrichHaToolResult(rawJson) {
  if (!rawJson || typeof rawJson !== 'string') return rawJson;
  let data;
  try {
    data = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }
  if (!data || typeof data !== 'object' || data.error) return rawJson;

  const out = { ...data };

  if (data.entity_id && data.state !== undefined) {
    out.summary = describeEntityState(data);
  }

  const rows = Array.isArray(data.entities)
    ? data.entities
    : Array.isArray(data.items)
      ? data.items
      : null;

  if (rows && rows.length > 0) {
    const summaries = rows.map((row) => describeEntityState(row)).filter(Boolean);
    out.summaries = summaries;
    out.summary = summaries.slice(0, 15).join('\n');
  }

  if (!out.summary && typeof data.message === 'string' && data.message.trim()) {
    out.summary = humanizeServiceMessage(data.message);
  }

  if (out.summary) {
    out.reply_hint = 'Answer the user in one or two short conversational sentences using summary only. Do not mention entity_id, domain names, or repeat the same reading twice.';
  }

  return JSON.stringify(out);
}
