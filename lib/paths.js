/**
 * State directory and paths. Config, auth, and cron live in ~/.pasture (or PASTURE_STATE_DIR).
 * Legacy ~/.cowcode is copied to ~/.pasture on first run when pasture does not exist yet.
 */

import { join } from 'path';
import { mkdirSync, existsSync, cpSync, writeFileSync } from 'fs';
import { homedir } from 'os';

const STATE_DIRNAME = '.pasture';
const LEGACY_STATE_DIRNAME = '.cowcode';

/**
 * Resolve state directory. Override with PASTURE_STATE_DIR (or legacy COWCODE_STATE_DIR).
 * Relative paths are resolved from home (not cwd) so auth/config are the same
 * whether run from terminal or daemon.
 * @returns {string} Absolute path to state dir (e.g. ~/.pasture).
 */
export function getStateDir() {
  const override = process.env.PASTURE_STATE_DIR?.trim() || process.env.COWCODE_STATE_DIR?.trim();
  if (override) return override.startsWith('/') ? override : join(homedir(), override);
  const pastureDir = join(homedir(), STATE_DIRNAME);
  const legacyDir = join(homedir(), LEGACY_STATE_DIRNAME);
  if (existsSync(pastureDir)) return pastureDir;
  if (existsSync(legacyDir)) return legacyDir;
  return pastureDir;
}

/**
 * One-time upgrade: copy ~/.cowcode -> ~/.pasture when upgrading from CowCode.
 * Fresh installs only create ~/.pasture. Legacy dir is left in place for rollback.
 * @returns {boolean} true when migration ran
 */
export function migrateLegacyStateDirIfNeeded() {
  const override = process.env.PASTURE_STATE_DIR?.trim() || process.env.COWCODE_STATE_DIR?.trim();
  if (override) return false;

  const pastureDir = join(homedir(), STATE_DIRNAME);
  const legacyDir = join(homedir(), LEGACY_STATE_DIRNAME);
  if (existsSync(pastureDir) || !existsSync(legacyDir)) return false;

  cpSync(legacyDir, pastureDir, { recursive: true });
  try {
    writeFileSync(
      join(legacyDir, '.migrated-to-pasture'),
      `Migrated to ${pastureDir} at ${new Date().toISOString()}\n`,
      'utf8',
    );
  } catch (_) {}
  console.log('[pasture] Migrated state from ~/.cowcode to ~/.pasture');
  return true;
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
 * @returns {string} Absolute path (e.g. ~/.pasture/workspace).
 */
export function getWorkspaceDir() {
  return join(getStateDir(), 'workspace');
}

/**
 * Directory for per-group configs (groups/<id>/). "default" uses legacy group/.
 * @returns {string} Absolute path (e.g. ~/.pasture/groups).
 */
export function getGroupsDir() {
  return join(getStateDir(), 'groups');
}

/**
 * Directory for per-agent data (config + identity files).
 * @returns {string} Absolute path (e.g. ~/.pasture/agents).
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

/**
 * Path to the agent's profile picture (avatar.png inside the agent dir).
 * The file may not exist — callers should check before serving.
 * @param {string} [agentId] - Agent id, defaults to "main".
 * @returns {string}
 */
export function getAgentAvatarPath(agentId = 'main') {
  return join(getAgentDir(agentId), 'avatar.png');
}

/** Safe filesystem dir name from group id (e.g. -12345 -> -12345). */
function sanitizeGroupId(groupId) {
  const s = String(groupId).trim();
  return s.replace(/[^0-9a-zA-Z\-_]/g, '_') || 'group';
}

/**
 * Config directory for one group. "default" = legacy ~/.pasture/group; others = ~/.pasture/groups/<id>.
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
 * @returns {string} Absolute path.
 */
export function getGroupDir(groupId) {
  return getGroupConfigDir(groupId);
}

/**
 * Group config path (group dir / config.json).
 * @param {string} [groupId] - Omit or "default" for legacy group/.
 * @returns {string} Absolute path.
 */
export function getGroupConfigPath(groupId) {
  return join(getGroupConfigDir(groupId), 'config.json');
}

/**
 * Memory index directory (contains index.db).
 * @returns {string} Absolute path (e.g. ~/.pasture/memory).
 */
export function getMemoryDir() {
  return join(getStateDir(), 'memory');
}

/**
 * SQLite memory index path.
 * @returns {string} Absolute path (e.g. ~/.pasture/memory/index.db).
 */
export function getMemoryIndexPath() {
  return join(getMemoryDir(), 'index.db');
}

/**
 * Uploads directory for user-sent images (vision).
 * @returns {string} Absolute path (e.g. ~/.pasture/uploads).
 */
export function getUploadsDir() {
  return join(getStateDir(), 'uploads');
}

/** Retrospective quality metrics (correction rate over time). */
export function getRetrospectiveMetricsPath() {
  return join(getStateDir(), 'retrospective-metrics.json');
}

/** Last nightly/weekly retrospective run timestamps. */
export function getRetrospectiveLastRunPath() {
  return join(getStateDir(), 'retrospective-last-run.json');
}

/** Team activity event stream (JSONL) for dashboard live feed. */
export function getTeamActivityLogPath() {
  return join(getStateDir(), 'team-activity.jsonl');
}

/** Live per-agent working memory for dashboard Active Context view. */
export function getAgentContextStatePath() {
  return join(getStateDir(), 'agent-context-state.json');
}

/** Persistent missions store used by mission engine + dashboard. */
export function getMissionsStorePath() {
  return join(getStateDir(), 'missions', 'missions.json');
}

/** Legacy missions store path, imported once into the mission store when present. */
export function getLegacyMissionsStorePath() {
  return join(getStateDir(), 'goals', 'goals.json');
}

/** AI suggestion compatibility store under the missions area. */
export function getAiSuggestedTasksStorePath() {
  return join(getStateDir(), 'missions', 'ai-suggested-tasks.json');
}

/** Legacy AI suggestions store path, imported into mission tasks when present. */
export function getLegacyAiSuggestedTasksStorePath() {
  return join(getStateDir(), 'initiatives.json');
}

/** Curiosity & momentum layer scheduler state. */
export function getCuriosityMomentumStatePath() {
  return join(getStateDir(), 'missions', 'curiosity-momentum.json');
}

/** Relative path in workspace for bad-case JSONL used by retrospective embeddings. */
export const RETROSPECTIVE_BAD_CASES_REL = 'retrospective/bad-cases.jsonl';

/**
 * Secrets file path — stores sensitive tokens (GitHub PAT, etc.) separately from config.json.
 * @returns {string} Absolute path (e.g. ~/.pasture/secrets.json).
 */
export function getSecretsPath() {
  return join(getStateDir(), 'secrets.json');
}

/**
 * Daily LLM usage counter (cloud calls only).
 * Shape: { date: "YYYY-MM-DD", count: N }
 * @returns {string} Absolute path (e.g. ~/.pasture/llm-usage.json).
 */
export function getLlmUsagePath() {
  return join(getStateDir(), 'llm-usage.json');
}

/**
 * Ensure state dir and subdirs (auth_info, cron, workspace, memory) exist.
 */
export function ensureStateDir() {
  migrateLegacyStateDirIfNeeded();
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
  const missionsDir = join(getStateDir(), 'missions');
  if (!existsSync(missionsDir)) mkdirSync(missionsDir, { recursive: true });
}
