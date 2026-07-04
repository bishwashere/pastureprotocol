import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getTeamsStorePath } from '../util/paths.js';
import {
  DEFAULT_AGENT_ID,
  listAgentIds,
  loadAgentConfig,
  saveAgentConfig,
  isInternalAgent,
} from './agent-config.js';

export const DEFAULT_TEAM_ID = 'default';

function readJson(path, fallback = {}) {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

export function normalizeTeamId(input) {
  const id = String(input || '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return id || DEFAULT_TEAM_ID;
}

export function normalizeTeamName(input, teamId = DEFAULT_TEAM_ID) {
  const name = String(input || '').trim();
  if (name) return name.length > 120 ? name.slice(0, 120) : name;
  return normalizeTeamId(teamId) === DEFAULT_TEAM_ID ? 'Default team' : normalizeTeamId(teamId);
}

function baseStore() {
  const now = Date.now();
  return {
    teams: {
      [DEFAULT_TEAM_ID]: {
        id: DEFAULT_TEAM_ID,
        name: 'Default team',
        createdAt: now,
        updatedAt: now,
      },
    },
  };
}

function normalizeStore(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const teams = src.teams && typeof src.teams === 'object' && !Array.isArray(src.teams)
    ? src.teams
    : {};
  const out = { teams: {} };
  for (const [key, value] of Object.entries(teams)) {
    const id = normalizeTeamId(value?.id || key);
    const createdAt = Number(value?.createdAt) || Date.now();
    out.teams[id] = {
      id,
      name: normalizeTeamName(value?.name, id),
      createdAt,
      updatedAt: Number(value?.updatedAt) || createdAt,
    };
  }
  if (!out.teams[DEFAULT_TEAM_ID]) {
    out.teams[DEFAULT_TEAM_ID] = baseStore().teams[DEFAULT_TEAM_ID];
  }
  return out;
}

export function loadTeamsStore() {
  return normalizeStore(readJson(getTeamsStorePath(), baseStore()));
}

export function saveTeamsStore(store) {
  const normalized = normalizeStore(store);
  writeJson(getTeamsStorePath(), normalized);
  return normalized;
}

export function ensureTeam(teamId = DEFAULT_TEAM_ID, options = {}) {
  const id = normalizeTeamId(teamId || options.name || DEFAULT_TEAM_ID);
  const store = loadTeamsStore();
  const existing = store.teams[id];
  if (existing) {
    const nextName = options.name !== undefined ? normalizeTeamName(options.name, id) : existing.name;
    if (nextName !== existing.name) {
      existing.name = nextName;
      existing.updatedAt = Date.now();
      saveTeamsStore(store);
    }
    return { team: existing, created: false };
  }
  const now = Date.now();
  const team = {
    id,
    name: normalizeTeamName(options.name, id),
    createdAt: now,
    updatedAt: now,
  };
  store.teams[id] = team;
  saveTeamsStore(store);
  return { team, created: true };
}

export function listTeams() {
  const store = loadTeamsStore();
  return Object.values(store.teams)
    .sort((a, b) => {
      if (a.id === DEFAULT_TEAM_ID) return -1;
      if (b.id === DEFAULT_TEAM_ID) return 1;
      return String(a.name || a.id).localeCompare(String(b.name || b.id));
    })
    .map((team) => ({
      ...team,
      members: listTeamMemberIds(team.id),
    }));
}

export function updateTeam(teamId, patch = {}) {
  const id = normalizeTeamId(teamId);
  const store = loadTeamsStore();
  if (!store.teams[id]) throw new Error(`Team not found: ${id}`);
  if (patch.name !== undefined) {
    store.teams[id].name = normalizeTeamName(patch.name, id);
  }
  store.teams[id].updatedAt = Date.now();
  saveTeamsStore(store);
  return {
    ...store.teams[id],
    members: listTeamMemberIds(id),
  };
}

export function getAgentTeamId(agentId = DEFAULT_AGENT_ID) {
  const id = String(agentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  const cfg = loadAgentConfig(id);
  return normalizeTeamId(cfg.teamId || DEFAULT_TEAM_ID);
}

export function listTeamMemberIds(teamId = DEFAULT_TEAM_ID) {
  const id = normalizeTeamId(teamId);
  return listAgentIds()
    .filter((agentId) => !isInternalAgent(agentId))
    .filter((agentId) => getAgentTeamId(agentId) === id);
}

export function sameTeam(agentA, agentB) {
  const a = String(agentA || '').trim();
  const b = String(agentB || '').trim();
  if (!a || !b) return false;
  return getAgentTeamId(a) === getAgentTeamId(b);
}

export function assignAgentToTeam(agentId, teamId = DEFAULT_TEAM_ID, options = {}) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('agentId is required');
  if (isInternalAgent(id)) throw new Error(`Cannot assign internal agent "${id}" to a team`);
  if (!listAgentIds().includes(id)) throw new Error(`Unknown agent "${id}"`);
  const { team } = ensureTeam(teamId, { name: options.teamName });
  const cfg = loadAgentConfig(id);
  cfg.teamId = team.id;
  saveAgentConfig(id, cfg);
  return { agentId: id, teamId: team.id, team };
}

export function unassignAgentFromTeam(agentId) {
  return assignAgentToTeam(agentId, DEFAULT_TEAM_ID);
}

export function teamSummaryForAgent(agentId = DEFAULT_AGENT_ID) {
  const teamId = getAgentTeamId(agentId);
  const store = loadTeamsStore();
  const team = store.teams[teamId] || ensureTeam(teamId).team;
  return {
    ...team,
    members: listTeamMemberIds(teamId),
  };
}
