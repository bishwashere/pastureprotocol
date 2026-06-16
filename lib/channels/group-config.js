/**
 * Group-level config now contains only additive restrictions and routing hints:
 * - agentId: which agent should handle this group (optional; defaults to "main")
 * - skillsDeny: additional denied skills for this group
 * - tools.deny: optional extra tool deny list
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { getGroupConfigPath, getGroupConfigDir } from './paths.js';
import { DEFAULT_AGENT_ID } from './agent-config.js';

const EMPTY_RESTRICTIONS = Object.freeze({
  agentId: DEFAULT_AGENT_ID,
  skillsDeny: [],
  tools: { deny: [] },
});

function readJson(path) {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalize(raw, fallbackAgentId = DEFAULT_AGENT_ID) {
  const agentId = typeof raw.agentId === 'string' && raw.agentId.trim() ? raw.agentId.trim() : fallbackAgentId;
  const skillsDeny = Array.isArray(raw.skillsDeny) ? raw.skillsDeny.map((s) => String(s).trim()).filter(Boolean) : [];
  const toolsDeny = Array.isArray(raw?.tools?.deny) ? raw.tools.deny.map((s) => String(s).trim()).filter(Boolean) : [];
  return { agentId, skillsDeny, tools: { deny: toolsDeny } };
}

/**
 * Ensure a group has a config dir and minimal restrictions config.
 */
export function ensureGroupDirInitialized() {
  ensureGroupConfigFor('default');
}

/**
 * Ensure a group has restrictions config.
 * @param {string} groupId
 */
export function ensureGroupConfigFor(groupId) {
  const id = groupId || 'default';
  const groupDir = getGroupConfigDir(id);
  if (!existsSync(groupDir)) mkdirSync(groupDir, { recursive: true });
  const configPath = getGroupConfigPath(id);
  if (existsSync(configPath)) return;
  writeFileSync(configPath, JSON.stringify(EMPTY_RESTRICTIONS, null, 2), 'utf8');
}

/**
 * Get effective group restrictions (specific + default merged).
 * Default and specific deny lists are additive.
 */
export function getGroupRestrictions(groupId) {
  const id = groupId || 'default';
  ensureGroupConfigFor('default');
  if (id !== 'default') ensureGroupConfigFor(id);

  const def = normalize(readJson(getGroupConfigPath('default')), DEFAULT_AGENT_ID);
  if (id === 'default') return def;
  const specific = normalize(readJson(getGroupConfigPath(id)), def.agentId);

  const skillsDeny = Array.from(new Set([...(def.skillsDeny || []), ...(specific.skillsDeny || [])]));
  const toolsDeny = Array.from(new Set([...(def.tools?.deny || []), ...(specific.tools?.deny || [])]));
  return {
    agentId: specific.agentId || def.agentId || DEFAULT_AGENT_ID,
    skillsDeny,
    tools: { deny: toolsDeny },
  };
}

/**
 * Backward-compat helper for callers that still import readGroupMd.
 * Group-specific identity/soul files are no longer used.
 */
export function readGroupMd() {
  return '';
}

export function saveGroupRestrictions(groupId, next) {
  const id = groupId || 'default';
  ensureGroupConfigFor(id);
  const current = getGroupRestrictions(id);
  const merged = normalize({
    agentId: next?.agentId ?? current.agentId,
    skillsDeny: next?.skillsDeny ?? current.skillsDeny,
    tools: next?.tools ?? current.tools,
  }, DEFAULT_AGENT_ID);
  const configPath = getGroupConfigPath(id);
  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * Legacy compatibility method used by a few call sites.
 * Returns a list of enabled skills by applying group deny on top of base list.
 */
export function getGroupSkillsEnabled(groupId, baseEnabled = []) {
  const restrictions = getGroupRestrictions(groupId);
  const deny = new Set(Array.isArray(restrictions.skillsDeny) ? restrictions.skillsDeny : []);
  return (Array.isArray(baseEnabled) ? baseEnabled : []).filter((id) => !deny.has(id));
}

/**
 * Migrate old group config shape (llm/skills.enabled and group identity files) to restrictions-only.
 * The caller should own any filesystem cleanup of old per-group files.
 */
export function normalizeLegacyGroupConfig(groupId) {
  const id = groupId || 'default';
  const path = getGroupConfigPath(id);
  if (!existsSync(path)) {
    ensureGroupConfigFor(id);
    return getGroupRestrictions(id);
  }
  const raw = readJson(path);
  if (Array.isArray(raw.skillsDeny) || raw.agentId || raw?.tools?.deny) {
    return saveGroupRestrictions(id, raw);
  }
  // Keep permissive default after migration since user requested full reset of old group behavior.
  return saveGroupRestrictions(id, { agentId: DEFAULT_AGENT_ID, skillsDeny: [], tools: { deny: [] } });
}
