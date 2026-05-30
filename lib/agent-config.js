import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { getConfigPath, getWorkspaceDir, getAgentDir, getAgentConfigPath, getAgentWorkspaceDir, getGroupsDir, getGroupConfigDir, getAgentsDir } from './paths.js';

export const DEFAULT_AGENT_ID = 'main';

/** Internal agents (retrospective, etc.) — exist on disk but hidden from team UI/config. */
export const REFLECTOR_AGENT_ID = 'reflector';
const INTERNAL_AGENT_IDS = new Set([REFLECTOR_AGENT_ID]);

export function isInternalAgent(agentId) {
  return INTERNAL_AGENT_IDS.has(String(agentId || '').trim());
}

/** User-facing agents only (team map, editor, agent-send targets). */
export function listVisibleAgentIds() {
  return listAgentIds().filter((id) => !isInternalAgent(id));
}

const IDENTITY_FILES = ['SOUL.md', 'WhoAmI.md', 'MyHuman.md', 'group.md', 'MEMORY.md'];
const NEW_AGENT_SKILLS_DENY_BY_DEFAULT = new Set([
  'speech',
  'home-assistant',
  'gog',
  'go-write',
  'apply-patch',
  'write',
  'agent-send',
]);

/** Defaults for agent-to-agent messaging when an agent has no explicit policy. */
const DEFAULT_AGENT_MESSAGING = Object.freeze({
  allow: [],
  maxDepth: 2,
  maxCallsPerTurn: 5,
});

const TEAM_PROMPT_HIDDEN_SKILLS = new Set(['agent-send', 'background-tasks']);

function readJson(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2), 'utf8');
}

function normalizeAgentId(input) {
  const id = String(input || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return id || '';
}

export function ensureAgent(agentId = DEFAULT_AGENT_ID) {
  const dir = getAgentDir(agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const workspace = getAgentWorkspaceDir(agentId);
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  const configPath = getAgentConfigPath(agentId);
  if (!existsSync(configPath)) {
    writeJson(configPath, {});
  }
}

/**
 * Bootstraps main agent from legacy state (main config/workspace).
 * Safe to call repeatedly — only seeds agent config when it is still empty.
 */
export function ensureMainAgentInitialized() {
  ensureAgent(DEFAULT_AGENT_ID);
  const mainConfigPath = getConfigPath();
  const agentConfigPath = getAgentConfigPath(DEFAULT_AGENT_ID);
  const existing = readJson(agentConfigPath, {});
  if (Object.keys(existing).length === 0 && existsSync(mainConfigPath)) {
    const legacy = readJson(mainConfigPath, {});
    writeJson(agentConfigPath, legacy);
  }
  const legacyWorkspace = getWorkspaceDir();
  const agentWorkspace = getAgentWorkspaceDir(DEFAULT_AGENT_ID);
  for (const name of IDENTITY_FILES) {
    const src = join(legacyWorkspace, name);
    const dest = join(agentWorkspace, name);
    if (existsSync(src) && !existsSync(dest)) {
      try {
        copyFileSync(src, dest);
      } catch (_) {}
    }
  }
}

export function loadAgentConfig(agentId = DEFAULT_AGENT_ID) {
  ensureMainAgentInitialized();
  ensureAgent(agentId);
  const cfg = readJson(getAgentConfigPath(agentId), {});
  if (Object.keys(cfg).length > 0) return cfg;
  if (agentId !== DEFAULT_AGENT_ID) {
    return loadAgentConfig(DEFAULT_AGENT_ID);
  }
  return {};
}

export function saveAgentConfig(agentId, config) {
  ensureAgent(agentId);
  syncAgentSendSkillInConfig(config || {});
  writeJson(getAgentConfigPath(agentId), config || {});
  if (agentId === DEFAULT_AGENT_ID) {
    writeJson(getConfigPath(), config || {});
  }
}

/** Optional display title stored in agent config.json (empty if unset). */
export function getAgentTitle(agentId = DEFAULT_AGENT_ID) {
  const cfg = loadAgentConfig(agentId);
  return typeof cfg.title === 'string' ? cfg.title.trim() : '';
}

function normalizeAgentMessaging(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allow = normalizeAgentAllowList(Array.isArray(src.allow) ? src.allow : []);
  const maxDepth = Number.isFinite(src.maxDepth) && src.maxDepth > 0
    ? Math.floor(src.maxDepth)
    : DEFAULT_AGENT_MESSAGING.maxDepth;
  const maxCallsPerTurn = Number.isFinite(src.maxCallsPerTurn) && src.maxCallsPerTurn > 0
    ? Math.floor(src.maxCallsPerTurn)
    : DEFAULT_AGENT_MESSAGING.maxCallsPerTurn;
  return { allow, maxDepth, maxCallsPerTurn };
}

/** Optional nicknames for an agent (e.g. after a title change). Stored in config.json. */
export function getAgentAliases(agentId = DEFAULT_AGENT_ID) {
  const cfg = loadAgentConfig(agentId);
  if (!Array.isArray(cfg.aliases)) return [];
  return cfg.aliases.map((a) => normalizeAgentId(a)).filter(Boolean);
}

/**
 * Resolve a user/LLM reference (id, title, or alias) to a canonical agent id.
 * Returns empty string when nothing matches.
 */
export function resolveAgentReference(input, options = {}) {
  const allowInternal = options.allowInternal === true;
  const raw = String(input || '').trim();
  if (!raw) return '';
  const normalized = normalizeAgentId(raw);
  const known = listAgentIds();
  if (known.includes(normalized)) {
    if (isInternalAgent(normalized) && !allowInternal) return '';
    return normalized;
  }
  const rawLower = raw.toLowerCase();
  for (const agentId of known) {
    if (isInternalAgent(agentId) && !allowInternal) continue;
    const title = getAgentTitle(agentId);
    if (title && title.toLowerCase() === rawLower) return agentId;
    if (title && normalizeAgentId(title) === normalized) return agentId;
    for (const alias of getAgentAliases(agentId)) {
      if (alias === normalized) return agentId;
    }
  }
  return '';
}

/**
 * Normalize allow-list entries to canonical agent ids; drop unknown/stale ids.
 */
export function normalizeAgentAllowList(allow) {
  if (!Array.isArray(allow)) return [];
  const known = new Set(listAgentIds());
  const out = [];
  for (const entry of allow) {
    const resolved = resolveAgentReference(entry) || normalizeAgentId(entry);
    if (resolved && known.has(resolved) && !isInternalAgent(resolved) && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Roster block for the system prompt — canonical ids, titles, and delegation links.
 */
export function buildAgentTeamPromptBlock(callerAgentId = DEFAULT_AGENT_ID) {
  const ids = listVisibleAgentIds();
  if (ids.length <= 1) return '';
  const policy = getAgentMessagingPolicy(callerAgentId);
  const lines = [
    '# Agent team',
    'When delegating, use each agent\'s canonical id from the roster (user titles and nicknames map to those ids).',
    'Prefer the teammate whose enabled skills best match the request.',
  ];
  for (const id of ids) {
    const title = getAgentTitle(id);
    const aliases = getAgentAliases(id);
    const cfg = loadAgentConfig(id);
    const enabledSkills = Array.isArray(cfg?.skills?.enabled)
      ? cfg.skills.enabled.filter((sid) => sid && !TEAM_PROMPT_HIDDEN_SKILLS.has(String(sid)))
      : [];
    let line = `- ${id}`;
    if (title) line += ` (title: ${title})`;
    if (aliases.length) line += ` (also known as: ${aliases.join(', ')})`;
    if (enabledSkills.length) line += ` (skills: ${enabledSkills.join(', ')})`;
    lines.push(line);
  }
  if (policy.allow.length) {
    lines.push('');
    lines.push(`You may delegate via agent-send to: ${policy.allow.join(', ')}`);
    lines.push('If no single teammate is obvious, use agent-send with agent="auto" and include the full task message.');
  } else if (callerAgentId === DEFAULT_AGENT_ID) {
    lines.push('');
    lines.push('No team links configured for you yet — add links on the agent map to delegate.');
  }
  return '\n\n' + lines.join('\n');
}

/** Record a title change as an alias so old names still resolve. */
export function appendAgentTitleAlias(config, previousTitle) {
  if (!config || typeof config !== 'object') return config;
  const prev = normalizeAgentTitle(previousTitle);
  if (!prev) return config;
  const alias = normalizeAgentId(prev);
  if (!alias) return config;
  if (!Array.isArray(config.aliases)) config.aliases = [];
  if (!config.aliases.includes(alias)) config.aliases.push(alias);
  return config;
}

export function normalizeAgentTitle(input) {
  const t = String(input || '').trim();
  if (!t) return '';
  return t.length > 120 ? t.slice(0, 120) : t;
}

export function normalizeAgentMessagingPolicy(raw) {
  return normalizeAgentMessaging(raw);
}

/**
 * agent-send is implicit: enabled when this agent has team links (allow paths).
 * @param {string} agentId
 * @param {string[]} [enabledSkills]
 * @returns {boolean}
 */
export function agentSendEnabledForAgent(agentId, enabledSkills = null) {
  const policy = getAgentMessagingPolicy(agentId);
  if (policy.allow.length > 0) return true;
  const enabled = Array.isArray(enabledSkills)
    ? enabledSkills
    : (() => {
        const cfg = loadAgentConfig(agentId);
        return Array.isArray(cfg.skills?.enabled) ? cfg.skills.enabled : [];
      })();
  return enabled.includes('agent-send');
}

/**
 * Keep skills.enabled in sync with team links — no separate agent-send toggle.
 * @param {object} config
 * @returns {object}
 */
export function syncAgentSendSkillInConfig(config) {
  if (!config || typeof config !== 'object') return config;
  const policy = normalizeAgentMessaging(config.agentMessaging);
  config.agentMessaging = policy;
  if (!config.skills) config.skills = {};
  if (!Array.isArray(config.skills.enabled)) config.skills.enabled = [];
  const hasLinks = policy.allow.length > 0;
  const idx = config.skills.enabled.indexOf('agent-send');
  if (hasLinks && idx === -1) config.skills.enabled.push('agent-send');
  if (!hasLinks && idx !== -1) config.skills.enabled.splice(idx, 1);
  config.skills.enabled = config.skills.enabled.filter((id) => id !== 'background-tasks');
  return config;
}

/**
 * Inject agent-send when team links exist (paths on the agent map).
 * @param {string} agentId
 * @param {string[]} enabled
 * @returns {string[]}
 */
export function resolveEnabledSkillsForAgent(agentId, enabled) {
  const list = Array.isArray(enabled) ? enabled.slice() : [];
  if (getAgentMessagingPolicy(agentId).allow.length > 0 && !list.includes('agent-send')) {
    list.push('agent-send');
  }
  return list;
}

export function createAgent(agentIdInput, options = {}) {
  ensureMainAgentInitialized();
  const agentId = normalizeAgentId(agentIdInput);
  if (!agentId) throw new Error('Agent id is required');
  if (isInternalAgent(agentId) && !options.internal) {
    throw new Error(`Agent id "${agentId}" is reserved`);
  }
  if (agentId === DEFAULT_AGENT_ID) return { id: DEFAULT_AGENT_ID, created: false };
  if (listAgentIds().includes(agentId)) return { id: agentId, created: false };

  const fromId = options.fromAgentId || DEFAULT_AGENT_ID;
  const baseConfig = loadAgentConfig(fromId);
  const baseEnabled = (baseConfig.skills && Array.isArray(baseConfig.skills.enabled))
    ? baseConfig.skills.enabled
    : ['search', 'browse', 'vision', 'memory', 'read', 'me', 'go-read', 'write', 'edit'];
  const filteredEnabled = baseEnabled.filter((id) => !NEW_AGENT_SKILLS_DENY_BY_DEFAULT.has(String(id)));
  const config = {
    llm: baseConfig.llm || {},
    skills: { ...(baseConfig.skills || {}), enabled: filteredEnabled },
  };
  const title = normalizeAgentTitle(options.title);
  if (title) config.title = title;
  saveAgentConfig(agentId, config);

  const ws = getAgentWorkspaceDir(agentId);
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
  const baseWs = getAgentWorkspaceDir(fromId);
  for (const name of IDENTITY_FILES) {
    const src = join(baseWs, name);
    const dst = join(ws, name);
    if (existsSync(src) && !existsSync(dst)) {
      try { copyFileSync(src, dst); } catch (_) {}
    }
  }
  // New agents must not inherit memory context from another agent.
  writeFileSync(join(ws, 'MEMORY.md'), '', 'utf8');
  if (!existsSync(join(ws, 'WhoAmI.md'))) writeFileSync(join(ws, 'WhoAmI.md'), '', 'utf8');
  if (!existsSync(join(ws, 'MyHuman.md'))) writeFileSync(join(ws, 'MyHuman.md'), '', 'utf8');
  if (!existsSync(join(ws, 'SOUL.md'))) writeFileSync(join(ws, 'SOUL.md'), readAgentMd('SOUL.md', fromId), 'utf8');
  if (!existsSync(join(ws, 'group.md'))) writeFileSync(join(ws, 'group.md'), readAgentMd('group.md', fromId), 'utf8');
  return { id: agentId, created: true };
}

export function deleteAgent(agentIdInput) {
  ensureMainAgentInitialized();
  const agentId = normalizeAgentId(agentIdInput);
  if (!agentId) throw new Error('Agent id is required');
  if (isInternalAgent(agentId)) {
    throw new Error(`Cannot delete internal agent "${agentId}"`);
  }
  if (agentId === DEFAULT_AGENT_ID) {
    throw new Error('Cannot delete default agent "main"');
  }
  const dir = getAgentDir(agentId);
  if (!existsSync(dir)) return { id: agentId, deleted: false, reassignedGroups: 0 };

  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Failed to delete agent directory: ${err?.message || String(err)}`);
  }

  let reassignedGroups = 0;
  const candidates = [join(getGroupConfigDir('default'), 'config.json')];
  const groupsDir = getGroupsDir();
  if (existsSync(groupsDir)) {
    try {
      const entries = readdirSync(groupsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        candidates.push(join(groupsDir, e.name, 'config.json'));
      }
    } catch (_) {}
  }
  for (const cfgPath of candidates) {
    const raw = readJson(cfgPath, null);
    if (!raw || typeof raw !== 'object') continue;
    if (String(raw.agentId || '').trim() !== agentId) continue;
    raw.agentId = DEFAULT_AGENT_ID;
    try {
      writeJson(cfgPath, raw);
      reassignedGroups++;
    } catch (_) {}
  }
  return { id: agentId, deleted: true, reassignedGroups };
}

export function readAgentMd(filename, agentId = DEFAULT_AGENT_ID) {
  ensureMainAgentInitialized();
  const p = join(getAgentWorkspaceDir(agentId), filename);
  try {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch (_) {}
  if (agentId !== DEFAULT_AGENT_ID) return readAgentMd(filename, DEFAULT_AGENT_ID);
  return '';
}

export function listAgentIds() {
  ensureMainAgentInitialized();
  const agentsDir = getAgentsDir();
  try {
    const ids = readdirSync(agentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter(Boolean);
    return ids.length ? ids.sort() : [DEFAULT_AGENT_ID];
  } catch (_) {
    return [DEFAULT_AGENT_ID];
  }
}

/**
 * Agent-to-agent messaging policy for one agent (read from its config.json
 * under `agentMessaging`). Controls which other agents it may message and the
 * recursion/fan-out limits. Missing fields fall back to safe defaults.
 *
 * @param {string} agentId
 * @returns {{ allow: string[], maxDepth: number, maxCallsPerTurn: number }}
 */
export function getAgentMessagingPolicy(agentId = DEFAULT_AGENT_ID) {
  const cfg = loadAgentConfig(agentId);
  const raw = cfg && typeof cfg.agentMessaging === 'object' && cfg.agentMessaging ? cfg.agentMessaging : {};
  const normalized = normalizeAgentMessaging(raw);
  const rawAllow = Array.isArray(raw.allow) ? raw.allow.map((s) => normalizeAgentId(s)).filter(Boolean) : [];
  if (JSON.stringify(normalized.allow) !== JSON.stringify(rawAllow)) {
    cfg.agentMessaging = normalized;
    syncAgentSendSkillInConfig(cfg);
    saveAgentConfig(agentId, cfg);
    console.log('[agent-config] repaired allow list for', agentId, ':', rawAllow, '->', normalized.allow);
  }
  return normalized;
}

/** Normalize an agent id for external callers (same rules as create/delete). */
export function toAgentId(input) {
  return normalizeAgentId(input);
}

export function resolveAgentIdForGroup(groupId) {
  const fromDefault = readJson(join(getGroupConfigDir('default'), 'config.json'), {});
  const fromGroup = groupId ? readJson(join(getGroupConfigDir(groupId), 'config.json'), {}) : {};
  const groupAgent = typeof fromGroup.agentId === 'string' ? fromGroup.agentId.trim() : '';
  const defaultAgent = typeof fromDefault.agentId === 'string' ? fromDefault.agentId.trim() : '';
  return groupAgent || defaultAgent || DEFAULT_AGENT_ID;
}

/**
 * Delete legacy group-level files/config so groups no longer carry soul/llm/skills state.
 */
export function purgeLegacyGroups() {
  const defaultDir = getGroupConfigDir('default');
  if (existsSync(defaultDir)) {
    try { rmSync(defaultDir, { recursive: true, force: true }); } catch (_) {}
  }
  const groupsDir = getGroupsDir();
  if (existsSync(groupsDir)) {
    try {
      const names = readdirSync(groupsDir);
      for (const name of names) {
        const full = join(groupsDir, name);
        try {
          if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
        } catch (_) {}
      }
    } catch (_) {}
  }
}
