/**
 * Load skill docs for the LLM. Injects a compact list (name + description) per run;
 * when a skill is called, the executor runs it with full context.
 * Actions (tool variations) are defined in the same SKILL.md via a tool-schema block; no separate JS.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getConfigPath } from '../lib/util/paths.js';
import { getGroupRestrictions } from '../lib/channels/group-config.js';
import { loadAgentConfig, DEFAULT_AGENT_ID, resolveEnabledSkillsForAgent } from '../lib/agent/agent-config.js';
import { hasGithubToken } from '../lib/context/github-context.js';
import { GROUP_BLOCKED_SKILLS } from './executor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default skill ids enabled on new install and added by migration on update. */
export const DEFAULT_ENABLED = [
  'cron',
  'http',
  'search',
  'browse',
  'vision',
  'memory',
  'speech',
  'gog',
  'read',
  'me',
  'go-read',
  'go-write',
  'write',
  'edit',
  'apply-patch',
  'home-assistant',
  'github',
  'gmail',
  'calendar',
  'mongodb',
];

/** Always injected at runtime for chat; never toggled in config/UI. */
export const IMPLICIT_CHAT_SKILLS = ['background-tasks', 'project-workflow'];

/** Hidden from dashboard skill toggles (managed implicitly with team links). */
export const UI_HIDDEN_SKILL_IDS = new Set(['agent-send', 'background-tasks', 'evaluate-team-capability', 'project-workflow']);

const MD_NAMES = ['skill.md', 'SKILL.md'];
const COMPACT_DESC_MAX = 280;

export function applyImplicitChatSkills(enabled) {
  const list = Array.isArray(enabled) ? enabled.slice() : [];
  for (const id of IMPLICIT_CHAT_SKILLS) {
    if (!list.includes(id)) list.push(id);
  }
  return list;
}

export function stripImplicitSkillsFromConfig(enabled) {
  return (Array.isArray(enabled) ? enabled : []).filter((id) => !IMPLICIT_CHAT_SKILLS.includes(id));
}

function getSkillMdPath(skillId) {
  for (const name of MD_NAMES) {
    const p = join(__dirname, skillId, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse SKILL.md for compact metadata. Compatible with skills that follow the compact format:
 * YAML frontmatter with at least description: ; optional id: and name: (see skills/SKILL_FORMAT.md).
 * @param {string} skillMd - Raw file content
 * @param {string} skillId - Skill id (folder name)
 * @returns {{ name: string, description: string }} name = display label (frontmatter name or id, else skillId); description = one-line summary
 */
function parseCompactFromSkillMd(skillMd, skillId) {
  const match = skillMd.match(/^---\s*\n([\s\S]*?)\n---/);
  const block = match ? match[1] : '';
  const getFront = (key) => {
    const line = block.split('\n').find((l) => new RegExp('^' + key + '\\s*:', 'i').test(l));
    if (!line) return null;
    const value = line.replace(new RegExp('^' + key + '\\s*:\\s*', 'i'), '').trim();
    return value.replace(/^["']|["']$/g, '').trim() || null;
  };
  const desc = getFront('description');
  const name = getFront('name') || getFront('id') || skillId;
  const description = desc || (() => {
    const afterFront = skillMd.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
    const firstLine = afterFront.split('\n')[0] || '';
    return firstLine.replace(/^#+\s*/, '').trim() || skillId;
  })();
  const short = description.length > COMPACT_DESC_MAX ? description.slice(0, COMPACT_DESC_MAX - 3) + '...' : description;
  return { name, description: short };
}

/**
 * Parse a ```tool-schema ... ``` block from SKILL.md body. Returns array of { action, description, parameters } or null.
 * Format: action name on its own line, then indented (2 spaces) description: and parameters: paramName: type.
 * @param {string} skillMd - Full SKILL.md content
 * @returns {Array<{ action: string, description: string, parameters: Record<string, string> }> | null}
 */
function parseToolSchemaBlock(skillMd) {
  const match = skillMd.match(/```tool-schema\s*\n([\s\S]*?)```/);
  if (!match || !match[1]) return null;
  const block = match[1].trim();
  const actions = [];
  let current = null;
  for (const line of block.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      if (current) {
        actions.push(current);
        current = null;
      }
      continue;
    }
    if (!trimmed.startsWith('  ') && !trimmed.startsWith('\t')) {
      if (current) actions.push(current);
      current = { action: trimmed.split(/\s+/)[0], description: '', parameters: {} };
      continue;
    }
    const content = trimmed.trim();
    if (!current) continue;
    if (content.startsWith('description:')) {
      current.description = content.replace(/^description:\s*/, '').trim();
    } else if (content.startsWith('parameters:')) {
      current.parameters = {};
    } else if (content.includes(':') && current.parameters && typeof current.parameters === 'object') {
      const colon = content.indexOf(':');
      const key = content.slice(0, colon).trim();
      let type = content.slice(colon + 1).trim();
      const optional = /\(optional\)$/i.test(type);
      type = type.replace(/\s*\(optional\)\s*$/i, '').trim() || 'string';
      current.parameters[key] = type;
    }
  }
  if (current) actions.push(current);
  return actions.length > 0 ? actions : null;
}

/**
 * Build OpenAI-format parameters schema from parsed parameters object (paramName -> type string).
 * @param {Record<string, string>} params
 * @returns {{ type: 'object', properties: object, required: string[] }}
 */
function buildParametersSchema(params) {
  if (!params || Object.keys(params).length === 0) {
    return { type: 'object', properties: {}, required: [] };
  }
  const properties = {};
  const required = [];
  for (const [key, type] of Object.entries(params)) {
    const t = (type || 'string').toLowerCase();
    if (t === 'array') {
      properties[key] = {
        type: 'array',
        description: key,
        items: { type: 'string' },
      };
    } else if (t === 'object') {
      properties[key] = {
        type: 'object',
        description: key,
        additionalProperties: true,
      };
    } else {
      properties[key] = {
        type: t === 'number' || t === 'boolean' ? t : 'string',
        description: key,
      };
    }
    required.push(key);
  }
  return { type: 'object', properties, required };
}

/**
 * Normalize action name to executor action (strip skill prefix if present). Tool name is always skillId_action (e.g. cron_add).
 * @param {string} skillId - e.g. cron, go-read
 * @param {string} action - from schema, e.g. "add" or "cron_add"
 * @returns {{ toolName: string, executorAction: string }}
 */
function normalizeActionName(skillId, action) {
  const prefix = skillId.replace(/-/g, '_') + '_';
  const toolName = action.startsWith(prefix) ? action : prefix + action;
  const executorAction = action.startsWith(prefix) ? action.slice(prefix.length) : action;
  return { toolName, executorAction };
}

/**
 * Build one OpenAI-format tool per action when skill has a tool-schema block. Tool name = skillId_action (e.g. cron_add).
 * @param {string} skillId - e.g. cron, go-read
 * @param {Array<{ action: string, description: string, parameters: Record<string, string> }>} actions
 * @returns {Array<{ type: 'function', function: object }>}
 */
function buildToolsFromSchema(skillId, actions) {
  return actions.map(({ action, description, parameters }) => {
    const { toolName, executorAction } = normalizeActionName(skillId, action);
    return {
      type: 'function',
      function: {
        name: toolName,
        description: description || `Skill ${skillId}, action ${executorAction}.`,
        parameters: buildParametersSchema(parameters || {}),
      },
    };
  });
}

function normalizeEnabledList(list) {
  let normalized = Array.isArray(list) ? list : DEFAULT_ENABLED;
  if (normalized.includes('core')) {
    normalized = normalized.filter((id) => id !== 'core').concat('go-read', 'go-write');
  }
  return [...new Set(normalized)];
}

/** When the host has a GitHub token and github is enabled globally, all agents get the skill. */
function mergePlatformGithubSkill(enabled) {
  const list = Array.isArray(enabled) ? enabled.slice() : [];
  if (list.includes('github') || !hasGithubToken()) return list;
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const globalEnabled = normalizeEnabledList(config?.skills?.enabled);
    if (globalEnabled.includes('github')) list.push('github');
  } catch (_) {}
  return list;
}

function resolveEnabledForAgent(agentId, baseFiltered) {
  return mergePlatformGithubSkill(
    resolveEnabledSkillsForAgent(agentId, baseFiltered),
  );
}

export function getSkillsEnabled() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const skills = config.skills;
    if (!skills || typeof skills !== 'object') return DEFAULT_ENABLED;
    return normalizeEnabledList(skills.enabled);
  } catch {
    return DEFAULT_ENABLED;
  }
}

/**
 * Return the filtered list of enabled skill IDs for an agent/group without
 * reading any SKILL.md files — config reads only, very cheap.
 * Use this to feed the intent planner before loading full tool schemas.
 *
 * @param {{ groupJid?: string, agentId?: string }} [options]
 * @returns {string[]}
 */
export function getEnabledSkillIds(options = {}) {
  const { groupJid, agentId = DEFAULT_AGENT_ID } = options;
  const agentConfig = loadAgentConfig(agentId);
  const baseSkills = normalizeEnabledList(agentConfig?.skills?.enabled);
  const restrictions = groupJid ? getGroupRestrictions(groupJid) : null;
  const deny = new Set(Array.isArray(restrictions?.skillsDeny) ? restrictions.skillsDeny : []);
  if (groupJid) {
    for (const id of GROUP_BLOCKED_SKILLS) deny.add(id);
  }
  const list = applyImplicitChatSkills(resolveEnabledForAgent(agentId, baseSkills.filter((id) => !deny.has(id))));
  return list.filter((id) => !deny.has(id));
}

/**
 * Return enabled skill IDs paired with their one-line description from SKILL.md frontmatter.
 * Slightly more expensive than getEnabledSkillIds (reads SKILL.md per skill) but still cheap
 * compared to loading full tool schemas. Feed this to the intent planner so it can route by
 * meaning rather than just skill names.
 *
 * @param {{ groupJid?: string, agentId?: string }} [options]
 * @returns {Array<{ id: string, description: string }>}
 */
export function getEnabledSkillSummaries(options = {}) {
  const ids = getEnabledSkillIds(options);
  return ids.map((id) => {
    const mdPath = getSkillMdPath(id);
    if (!mdPath) return { id, description: id };
    try {
      const skillMd = readFileSync(mdPath, 'utf8').trim();
      const { description } = parseCompactFromSkillMd(skillMd, id);
      return { id, description };
    } catch {
      return { id, description: id };
    }
  });
}

/**
 * Load skill folders (SKILL.md with optional YAML front matter and optional tool-schema block).
 * If a skill defines a tool-schema in the same SKILL.md, one tool per action is built (explicit parameters).
 * Otherwise the skill is exposed via the single run_skill tool. No separate JS for actions.
 * @param {{ groupNonOwner?: boolean, groupJid?: string }} [options] - When groupNonOwner true, use group config; groupJid = that group's id for per-group skills.
 * @returns {{ compactList: string, runSkillTool: Array, getFullSkillDoc: (skillId: string) => string, toolNameToSkill: (name: string) => { skillId: string, action: string } | null }}
 */
export function getSkillContext(options = {}) {
  const { groupJid, agentId = DEFAULT_AGENT_ID, hintSkills } = options;
  const agentConfig = loadAgentConfig(agentId);
  const baseSkills = normalizeEnabledList(agentConfig?.skills?.enabled);
  const restrictions = groupJid ? getGroupRestrictions(groupJid) : null;
  const deny = new Set(Array.isArray(restrictions?.skillsDeny) ? restrictions.skillsDeny : []);
  if (groupJid) {
    for (const id of GROUP_BLOCKED_SKILLS) deny.add(id);
  }
  const enabled = applyImplicitChatSkills(resolveEnabledForAgent(agentId, baseSkills.filter((id) => !deny.has(id))))
    .filter((id) => !deny.has(id));
  // When the intent planner provided skill hints, restrict to only those skills.
  // Fall back to the full enabled list if the intersection is empty (safety net).
  const hinted =
    Array.isArray(hintSkills) && hintSkills.length > 0
      ? enabled.filter((id) => hintSkills.includes(id))
      : [];
  const idsToLoad = hinted.length > 0 ? hinted : enabled;
  const compactEntries = [];
  const fullDocsById = Object.create(null);
  const available = [];
  /** @type {Array<{ type: 'function', function: object }>} */
  const actionTools = [];
  /** skill ids that have no tool-schema (still use run_skill) */
  const availableRunSkill = [];
  /** map tool name (e.g. cron_list) -> { skillId, action } for agent to resolve */
  const toolNameToSkill = Object.create(null);

  for (const id of idsToLoad) {
    const mdPath = getSkillMdPath(id);
    if (!mdPath) continue;
    try {
      const skillMd = readFileSync(mdPath, 'utf8').trim();
      if (!skillMd) continue;
      available.push(id);
      const compact = parseCompactFromSkillMd(skillMd, id);
      compactEntries.push(`- **${id}**: ${compact.description}`);
      fullDocsById[id] = `## Skill: ${id}\n\n${skillMd}`;

      const actions = parseToolSchemaBlock(skillMd);
      if (actions && actions.length > 0) {
        const tools = buildToolsFromSchema(id, actions);
        actionTools.push(...tools);
        for (const { action } of actions) {
          const { toolName, executorAction } = normalizeActionName(id, action);
          const entry = { skillId: id, action: executorAction };
          if (id === 'memory') entry.toolName = toolName;
          toolNameToSkill[toolName] = entry;
        }
      } else {
        availableRunSkill.push(id);
      }
    } catch (_) {}
  }

  const compactList =
    compactEntries.length > 0
      ? 'Available skills and actions (use the specific tool for each action when listed below, or run_skill for others):\n\n' +
        compactEntries.join('\n')
      : '';
  const runSkillIntro =
    'Run a skill that does not have a dedicated action tool. Choose "skill" and "arguments"; set "command" or "arguments.action" to the operation. When you call run_skill, you will receive full doc for that skill in the tool result if needed.';
  const runSkillTool = [];
  if (actionTools.length > 0) runSkillTool.push(...actionTools);
  if (availableRunSkill.length > 0) {
    runSkillTool.push({
      type: 'function',
      function: {
        name: 'run_skill',
        description: compactList ? runSkillIntro + '\n\n' + compactList : runSkillIntro,
        parameters: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              enum: availableRunSkill,
              description: 'Skill id (for skills without a dedicated action tool).',
            },
            command: {
              type: 'string',
              description: 'Operation name. Use arguments.action if not set.',
            },
            arguments: {
              type: 'object',
              description: 'Skill-specific arguments. See full skill doc when you call a skill.',
              additionalProperties: true,
            },
          },
          required: ['skill', 'arguments'],
        },
      },
    });
  }

  function getFullSkillDoc(skillId) {
    return fullDocsById[skillId] || '';
  }

  function resolveToolName(name) {
    return toolNameToSkill[name] || null;
  }

  const skillDocs = available.length > 0 ? available.map((id) => fullDocsById[id]).join('\n\n---\n\n') : '';
  return { compactList, runSkillTool, getFullSkillDoc, skillDocs, resolveToolName };
}
