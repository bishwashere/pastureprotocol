/**
 * State directory and paths. Config, auth, and cron live in ~/.cowcode (or COWCODE_STATE_DIR).
 */

import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const STATE_DIRNAME = '.cowcode';

/**
 * Resolve state directory. Override with COWCODE_STATE_DIR.
 * Relative paths are resolved from home (not cwd) so auth/config are the same
 * whether run from terminal or daemon (e.g. launchd with WorkingDirectory=~/.cowcode).
 * @returns {string} Absolute path to state dir (e.g. ~/.cowcode).
 */
export function getStateDir() {
  const override = process.env.COWCODE_STATE_DIR?.trim();
  if (override) return override.startsWith('/') ? override : join(homedir(), override);
  return join(homedir(), STATE_DIRNAME);
}

/**
 * Config file path (state dir / config.json).
 */
export function getConfigPath() {
  return join(getStateDir(), 'config.json');
}

/**
 * Auth state directory for WhatsApp (Baileys).
 */
export function getAuthDir() {
  return join(getStateDir(), 'auth_info');
}

/**
 * Cron jobs store path (state dir / cron / jobs.json).
 */
export function getCronStorePath() {
  return join(getStateDir(), 'cron', 'jobs.json');
}

/**
 * Background chat tasks ledger (state dir / background-tasks / tasks.json).
 */
export function getBackgroundTasksStorePath() {
  return join(getStateDir(), 'background-tasks', 'tasks.json');
}

/**
 * .env file path in state dir.
 */
export function getEnvPath() {
  return join(getStateDir(), '.env');
}

/**
 * Workspace directory for memory files (MEMORY.md, memory/*.md).
 * @returns {string} Absolute path (e.g. ~/.cowcode/workspace).
 */
export function getWorkspaceDir() {
  return join(getStateDir(), 'workspace');
}

/**
 * Directory for per-group configs (groups/<id>/). "default" uses legacy group/.
 * @returns {string} Absolute path (e.g. ~/.cowcode/groups).
 */
export function getGroupsDir() {
  return join(getStateDir(), 'groups');
}

/**
 * Directory for per-agent data (config + identity files).
 * @returns {string} Absolute path (e.g. ~/.cowcode/agents).
 */
export function getAgentsDir() {
  return join(getStateDir(), 'agents');
}

/** Safe filesystem dir name from agent id. */
function sanitizeAgentId(agentId) {
  const s = String(agentId || '').trim();
  return s.replace(/[^0-9a-zA-Z\-_]/g, '_') || 'main';
}

/**
 * Directory for one agent.
 * @param {string} [agentId] - Agent id, defaults to "main".
 * @returns {string}
 */
export function getAgentDir(agentId = 'main') {
  return join(getAgentsDir(), sanitizeAgentId(agentId));
}

/**
 * Agent config path.
 * @param {string} [agentId] - Agent id, defaults to "main".
 * @returns {string}
 */
export function getAgentConfigPath(agentId = 'main') {
  return join(getAgentDir(agentId), 'config.json');
}

/**
 * Agent workspace dir (SOUL/WhoAmI/MyHuman and chat logs for that agent).
 * @param {string} [agentId] - Agent id, defaults to "main".
 * @returns {string}
 */
export function getAgentWorkspaceDir(agentId = 'main') {
  return join(getAgentDir(agentId), 'workspace');
}

/** Safe filesystem dir name from group id (e.g. -12345 -> -12345). */
function sanitizeGroupId(groupId) {
  const s = String(groupId).trim();
  return s.replace(/[^0-9a-zA-Z\-_]/g, '_') || 'group';
}

/**
 * Config directory for one group. "default" = legacy ~/.cowcode/group; others = ~/.cowcode/groups/<id>.
 * @param {string} [groupId] - Group id (e.g. Telegram chat id "-12345") or "default".
 * @returns {string} Absolute path.
 */
export function getGroupConfigDir(groupId) {
  if (!groupId || groupId === 'default') return join(getStateDir(), 'group');
  return join(getGroupsDir(), sanitizeGroupId(groupId));
}

/**
 * Group directory: SOUL, identity, and config. Legacy single group = default.
 * @param {string} [groupId] - Omit or "default" for legacy group/.
 * @returns {string} Absolute path (e.g. ~/.cowcode/group or ~/.cowcode/groups/-12345).
 */
export function getGroupDir(groupId) {
  return getGroupConfigDir(groupId);
}

/**
 * Group config path (group dir / config.json).
 * @param {string} [groupId] - Omit or "default" for legacy group/.
 * @returns {string} Absolute path (e.g. ~/.cowcode/group/config.json).
 */
export function getGroupConfigPath(groupId) {
  return join(getGroupConfigDir(groupId), 'config.json');
}

/**
 * Memory index directory (contains index.db).
 * @returns {string} Absolute path (e.g. ~/.cowcode/memory).
 */
export function getMemoryDir() {
  return join(getStateDir(), 'memory');
}

/**
 * SQLite memory index path.
 * @returns {string} Absolute path (e.g. ~/.cowcode/memory/index.db).
 */
export function getMemoryIndexPath() {
  return join(getMemoryDir(), 'index.db');
}

/**
 * Uploads directory for user-sent images (vision).
 * @returns {string} Absolute path (e.g. ~/.cowcode/uploads).
 */
export function getUploadsDir() {
  return join(getStateDir(), 'uploads');
}

/**
 * Secrets file path — stores sensitive tokens (GitHub PAT, etc.) separately from config.json.
 * This file should be gitignored and not committed. Only readable by the current user.
 * @returns {string} Absolute path (e.g. ~/.cowcode/secrets.json).
 */
export function getSecretsPath() {
  return join(getStateDir(), 'secrets.json');
}

/**
 * Ensure state dir and subdirs (auth_info, cron, workspace, memory) exist.
 */
export function ensureStateDir() {
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const authDir = getAuthDir();
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  const cronDir = join(getStateDir(), 'cron');
  if (!existsSync(cronDir)) mkdirSync(cronDir, { recursive: true });
  const workspaceDir = getWorkspaceDir();
  if (!existsSync(workspaceDir)) mkdirSync(workspaceDir, { recursive: true });
  const memoryDir = getMemoryDir();
  if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  const workspaceMemoryDir = join(workspaceDir, 'memory');
  if (!existsSync(workspaceMemoryDir)) mkdirSync(workspaceMemoryDir, { recursive: true });
  const chatLogDir = join(workspaceDir, 'chat-log');
  if (!existsSync(chatLogDir)) mkdirSync(chatLogDir, { recursive: true });
  const uploadsDir = getUploadsDir();
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const groupDir = getGroupDir('default');
  if (!existsSync(groupDir)) mkdirSync(groupDir, { recursive: true });
  const groupsDir = getGroupsDir();
  if (!existsSync(groupsDir)) mkdirSync(groupsDir, { recursive: true });
  const agentsDir = getAgentsDir();
  if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
  const mainAgentDir = getAgentDir('main');
  if (!existsSync(mainAgentDir)) mkdirSync(mainAgentDir, { recursive: true });
  const mainAgentWorkspaceDir = getAgentWorkspaceDir('main');
  if (!existsSync(mainAgentWorkspaceDir)) mkdirSync(mainAgentWorkspaceDir, { recursive: true });
}
