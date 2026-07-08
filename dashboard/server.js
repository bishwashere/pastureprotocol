#!/usr/bin/env node
/**
 * Pasture Protocol dashboard: web UI for status, crons, skills, LLM config.
 * Run: pasture dashboard  (or pnpm run dashboard from repo)
 * Serves on port 3847 by default (PASTURE_DASHBOARD_PORT).
 */

import dotenv from 'dotenv';
import express from 'express';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawn, execSync, execFileSync } from 'child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync, renameSync, createWriteStream, copyFileSync } from 'fs';
import { getConfigPath, getCronStorePath, getStateDir, getWorkspaceDir, getEnvPath, getAgentWorkspaceDir, getAgentAvatarPath, getLlmUsagePath } from '../lib/util/paths.js';
import { generateAndSaveAgentAvatar, hasAgentAvatar } from '../lib/agent/agent-avatar.js';
import { collectChatLogDateEntries, readChatLogDayExchanges, formatExchangesAsText, CHAT_LOG_DAY_PREFIX } from '../lib/context/chat-log.js';
import { readTeamActivity, pruneTeamActivityLogToToday, pruneTeamActivityForMission } from '../lib/agent/team-activity.js';
import { readAllAgentContext, clearMissionFromAgentContext } from '../lib/agent/agent-context-state.js';
import { readAgentMetrics } from '../lib/agent/agent-metrics.js';
import { listMissions, createMission, updateMission, getMission, runMissionTick, respondToMissionUserInput, deleteMission, readMissionMemory } from '../lib/context/missions.js';
import { listSuggestedTasks, getSuggestedTask, updateSuggestedTask, promoteSuggestedTaskToTask } from '../lib/context/ai-suggested-tasks.js';
import { runInternalAgentTurn } from '../lib/agent/internal-agent-turn.js';
import { collectBadExchanges, readQualityMetrics } from '../lib/agent/retrospective.js';
import { readSystemCrontabForConfig } from '../lib/util/system-crons.js';
import { DEFAULT_DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT } from '../lib/util/dashboard-url.js';
import { syncMainAgentIdentityFileFromWorkspace } from '../lib/agent/identity-sync.js';

// Use same state dir as main app (e.g. PASTURE_STATE_DIR from ~/.pasture/.env)
dotenv.config({ path: getEnvPath() });
import { getResolvedTimezone, getResolvedTimeFormat } from '../lib/util/timezone.js';
import { loadStore } from '../cron/store.js';
import { DEFAULT_ENABLED, UI_HIDDEN_SKILL_IDS, stripImplicitSkillsFromConfig } from '../skills/loader.js';
import { getGroupRestrictions, saveGroupRestrictions } from '../lib/channels/group-config.js';
import { ensureMainAgentInitialized, loadAgentConfig, saveAgentConfig, listVisibleAgentIds, isInternalAgent, DEFAULT_AGENT_ID, resolveAgentIdForGroup, createAgent, deleteAgent, getAgentMessagingPolicy, getAgentTitle, normalizeAgentTitle, normalizeAgentMessagingPolicy, syncAgentSendSkillInConfig, appendAgentTitleAlias } from '../lib/agent/agent-config.js';
import { DEFAULT_TEAM_ID, assignAgentToTeam, ensureTeam, getAgentTeamId, listTeams, normalizeTeamId, updateTeam } from '../lib/agent/teams.js';
import {
  getTideChecklistFromConfig,
  normalizeChecklistConfig,
  readLastChecklistRun,
  runTideChecklist,
} from '../lib/agent/tide-checklist.js';
import {
  listProjects, getProject, createProject, updateProject, deleteProject,
  getProjectGraph, createUpdate, editUpdate, deleteUpdate,
  createBranch, deleteBranch,
  normalizeProjectTeamId,
} from '../lib/context/projects-db.js';
import {
  listPendingProposals,
  approvePendingProposal,
  rejectPendingProposal,
} from '../lib/context/project-workflow-pending.js';
import { generateBrainChunkGraph } from '../lib/agent/brain-word-cloud.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INSTALL_DIR = process.env.PASTURE_INSTALL_DIR || ROOT;
const PORT = Number(process.env.PASTURE_DASHBOARD_PORT) || DEFAULT_DASHBOARD_PORT;
const HOST = process.env.PASTURE_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST;

const app = express();
app.use(express.json({ limit: Infinity }));
ensureMainAgentInitialized();

// Block dashboard UI when accessed via Tailscale (*.ts.net) — API only over Tailscale.
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.includes('.ts.net') && !req.path.startsWith('/api/')) {
    res.status(403).json({ error: 'Dashboard UI is not available over Tailscale. Use /api/* endpoints.' });
    return;
  }
  next();
});

const DAEMON_SCRIPT = join(INSTALL_DIR, 'scripts', 'daemon.sh');
const SKILLS_DIR = join(INSTALL_DIR, 'skills');

function getDaemonRunning() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const child = spawn('pm2', ['describe', 'pasture', '--no-color'], {
        cwd: INSTALL_DIR,
        env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
        shell: true,
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('close', (code) => {
        resolve(code === 0 && /\bstatus\b/i.test(out) && /\bonline\b/i.test(out));
      });
      child.on('error', () => resolve(false));
      return;
    }
    if (!existsSync(DAEMON_SCRIPT)) {
      resolve(false);
      return;
    }
    const child = spawn('bash', [DAEMON_SCRIPT, 'status'], {
      cwd: INSTALL_DIR,
      env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', () => {
      resolve(out.includes('Daemon is running') && !out.includes('Daemon is not running'));
    });
    child.on('error', () => resolve(false));
  });
}

function loadConfig() {
  ensureMainAgentInitialized();
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {}
  return loadAgentConfig(DEFAULT_AGENT_ID);
}

function saveConfig(config) {
  ensureMainAgentInitialized();
  saveAgentConfig(DEFAULT_AGENT_ID, config || {});
  writeFileSync(getConfigPath(), JSON.stringify(config || {}, null, 2), 'utf8');
}

function loadGroupConfig(groupId) {
  return getGroupRestrictions(groupId || 'default');
}

function saveGroupConfig(groupId, config) {
  return saveGroupRestrictions(groupId || 'default', config || {});
}

const SKILL_MD_NAMES = ['SKILL.md', 'skill.md'];

function getAllSkillIds() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => SKILL_MD_NAMES.some((name) => existsSync(join(SKILLS_DIR, d.name, name))))
    .map((d) => d.name);
}

function getUiSkillIds() {
  return getAllSkillIds().filter((id) => !UI_HIDDEN_SKILL_IDS.has(id));
}

/** Parse YAML-like front matter (--- ... ---) and return { description } (and id/name if present). */
function parseSkillFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function getSkillDescription(skillId) {
  for (const name of SKILL_MD_NAMES) {
    const mdPath = join(SKILLS_DIR, skillId, name);
    if (!existsSync(mdPath)) continue;
    try {
      const content = readFileSync(mdPath, 'utf8');
      const fm = parseSkillFrontMatter(content);
      return fm.description || '';
    } catch (_) {}
  }
  return '';
}

function getSkillMdPath(skillId) {
  if (!/^[a-z0-9-]+$/i.test(skillId)) return null;
  const dir = join(SKILLS_DIR, skillId);
  if (!existsSync(dir)) return null;
  for (const name of SKILL_MD_NAMES) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return join(dir, 'SKILL.md');
}

/**
 * Check whether a skill that requires external credentials is configured.
 * Returns 'ok' | 'missing' | null (null = no credential required).
 */
function getSkillConfigStatus(skillId) {
  const NEEDS_CONFIG = new Set(['github', 'gmail', 'calendar', 'gog', 'home-assistant', 'search', 'speech', 'ssh-inspect']);
  if (!NEEDS_CONFIG.has(skillId)) return null;

  if (skillId === 'github') {
    if (process.env.GITHUB_TOKEN) return 'ok';
    try {
      const secretsPath = join(getStateDir(), 'secrets.json');
      if (existsSync(secretsPath)) {
        const s = JSON.parse(readFileSync(secretsPath, 'utf8'));
        if (s?.github?.token) return 'ok';
      }
      const config = loadConfig();
      if (config?.skills?.github?.token) return 'ok-legacy';
    } catch (_) {}
    return 'missing';
  }

  if (skillId === 'gmail' || skillId === 'calendar' || skillId === 'gog') {
    // gog uses system OAuth — check if gog is installed and account is set
    const config = loadConfig();
    const account = config?.skills?.gog?.account || config?.skills?.[skillId]?.account || process.env.GOG_ACCOUNT;
    return account ? 'ok' : 'unchecked';
  }

  if (skillId === 'search') {
    const config = loadConfig();
    const key = config?.skills?.search?.apiKey || process.env.BRAVE_API_KEY;
    return key ? 'ok' : 'missing';
  }

  if (skillId === 'home-assistant') {
    const config = loadConfig();
    return config?.skills?.['home-assistant']?.url ? 'ok' : 'missing';
  }

  return null;
}

function getDaemonUptimeSeconds() {
  const path = join(getStateDir(), 'daemon.started');
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const startedAt = data?.startedAt;
    if (typeof startedAt !== 'number') return null;
    return Math.floor((Date.now() - startedAt) / 1000);
  } catch {
    return null;
  }
}

// ---- API key auth (optional) ----
// Set PASTURE_API_KEY in ~/.pasture/.env to require Bearer token on all /api/* routes.
// Auth is enforced for remote access (e.g. Tailscale *.ts.net) but skipped for local dashboard use.
const API_KEY = process.env.PASTURE_API_KEY || '';
if (API_KEY) {
  app.use('/api', (req, res, next) => {
    const host = req.headers.host || '';
    // Local dashboard access (not via Tailscale) does not require auth
    if (!host.includes('.ts.net')) {
      next();
      return;
    }
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== API_KEY) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });
}

// ---- API ----

function safeJsonParse(text) {
  const s = String(text || '').replace(/^\[Pasture\]\s*/i, '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

function buildMissionDraftPrompt({ title, objective, ownerAgentId, agentIds }) {
  return [
    'Create a persistent mission draft for an autonomous agent loop.',
    `Title: ${title || objective}`,
    `Objective: ${objective}`,
    `Preferred owner: ${ownerAgentId || 'main'}`,
    `Available owners: ${agentIds.join(', ')}`,
    '',
    'Return STRICT JSON only:',
    '{',
    '  "title": "short title",',
    '  "ownerAgentId": "one available owner id",',
    '  "planSteps": [{"title":"...", "status":"todo|doing|done|blocked"}],',
    '  "contextSnapshot": "small context",',
    '  "memoryAnchors": ["optional anchors"]',
    '}',
  ].join('\n');
}

async function buildMissionDraftViaMainAgent({ title, objective, ownerAgentId }) {
  const agentIds = listVisibleAgentIds();
  const prompt = buildMissionDraftPrompt({ title, objective, ownerAgentId, agentIds });
  const turn = await runInternalAgentTurn({
    targetAgentId: DEFAULT_AGENT_ID,
    userText: prompt,
    callerAgentId: DEFAULT_AGENT_ID,
    depth: 1,
    callChain: [DEFAULT_AGENT_ID, DEFAULT_AGENT_ID],
    persistHistory: true,
  });
  const parsed = safeJsonParse(turn?.textToSend || '') || {};
  const resolvedOwner = String(parsed.ownerAgentId || ownerAgentId || DEFAULT_AGENT_ID).trim();
  return {
    title: String(parsed.title || title || objective || '').trim(),
    ownerAgentId: agentIds.includes(resolvedOwner) ? resolvedOwner : (ownerAgentId || DEFAULT_AGENT_ID),
    currentPlan: {
      steps: Array.isArray(parsed.planSteps) ? parsed.planSteps : [],
    },
    contextSnapshot: String(parsed.contextSnapshot || '').trim(),
    memoryAnchors: Array.isArray(parsed.memoryAnchors) ? parsed.memoryAnchors : [],
  };
}

app.get('/api/status', async (_req, res) => {
  try {
    const daemonRunning = await getDaemonRunning();
    const dashboardUrl = `http://${HOST}:${PORT}`;
    res.json({
      daemonRunning,
      dashboardUrl,
      port: PORT,
      stateDir: getStateDir(),
      installDir: INSTALL_DIR,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/overview', async (_req, res) => {
  try {
    const daemonRunning = await getDaemonRunning();
    const dashboardUrl = `http://${HOST}:${PORT}`;
    const storePath = getCronStorePath();
    const store = loadStore(storePath);
    const jobs = store.jobs || [];
    const cronCount = jobs.filter((j) => j.enabled !== false).length;
    const config = loadConfig();
    const skillsEnabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : DEFAULT_ENABLED;
    const skillsEnabledCount = skillsEnabled.length;
    const groupConfig = loadGroupConfig('default');
    const groupSkillsDeniedCount = Array.isArray(groupConfig.skillsDeny) ? groupConfig.skillsDeny.length : 0;
    const models = Array.isArray(config.llm?.models) ? config.llm.models : [];
    const priorityEntry = models.find((m) => m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true') || models[0];
    const priorityModelLabel = priorityEntry ? (priorityEntry.model ? `${priorityEntry.model}` : priorityEntry.provider || '—') : '—';
    const timezone = getResolvedTimezone();
    const timeFormat = getResolvedTimeFormat();
    const daemonUptimeSeconds = daemonRunning ? getDaemonUptimeSeconds() : null;
    res.json({
      daemonRunning,
      dashboardUrl,
      port: PORT,
      stateDir: getStateDir(),
      installDir: INSTALL_DIR,
      cronCount,
      skillsEnabledCount,
      groupSkillsDeniedCount,
      groupSkillsEnabledCount: Math.max(0, skillsEnabledCount - groupSkillsDeniedCount),
      priorityModelLabel,
      timezone,
      timeFormat,
      daemonUptimeSeconds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crons', (_req, res) => {
  try {
    const config = loadConfig();
    const storePath = getCronStorePath();
    const store = loadStore(storePath);
    const crontab = readSystemCrontabForConfig(config);
    res.json({
      jobs: store.jobs || [],
      system: crontab.entries || [],
      crontab: {
        ok: crontab.ok,
        empty: !!crontab.empty,
        error: crontab.error || null,
        user: crontab.user || null,
        skillRequired: crontab.skillRequired || null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/skills', (_req, res) => {
  try {
    const config = loadConfig();
    const enabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : DEFAULT_ENABLED;
    const allIds = getUiSkillIds();
    const list = allIds.map((id) => ({
      id,
      enabled: enabled.includes(id),
      description: getSkillDescription(id),
      configStatus: getSkillConfigStatus(id),
    }));
    res.json({ skills: list, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/skills/:id/doc', (req, res) => {
  try {
    const id = req.params.id;
    const mdPath = getSkillMdPath(id);
    if (!mdPath) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const content = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : '';
    const description = getSkillDescription(id);
    res.json({ id, description, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/skills/:id/doc', (req, res) => {
  try {
    const id = req.params.id;
    const mdPath = getSkillMdPath(id);
    if (!mdPath) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    writeFileSync(mdPath, content, 'utf8');
    res.json({ id, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/skills', (req, res) => {
  try {
    const { enabled } = req.body;
    if (!Array.isArray(enabled)) {
      res.status(400).json({ error: 'enabled must be an array' });
      return;
    }
    const config = loadConfig();
    if (!config.skills) config.skills = {};
    config.skills.enabled = stripImplicitSkillsFromConfig(enabled).filter((id) => id !== 'agent-send');
    saveConfig(config);
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function rejectInternalAgent(id, res) {
  if (isInternalAgent(id)) {
    res.status(404).json({ error: 'Agent not found' });
    return true;
  }
  return false;
}

app.get('/api/agents', (_req, res) => {
  try {
    const ids = listVisibleAgentIds();
    const agents = ids.map((id) => {
      const config = loadAgentConfig(id);
      const skillsEnabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : DEFAULT_ENABLED;
      return {
        id,
        title: getAgentTitle(id),
        skillsEnabled,
        hasLlm: !!config.llm,
        agentMessaging: getAgentMessagingPolicy(id),
        hasAgentLinks: getAgentMessagingPolicy(id).allow.length > 0,
        teamId: getAgentTeamId(id),
        isolated: config.isolated === true,
        sharedUserMemory: config.sharedUserMemory !== false && config.isolated !== true,
        color: typeof config.color === 'string' ? config.color : null,
        avatarUrl: (() => {
          if (!hasAgentAvatar(id)) return null;
          try {
            const mtime = statSync(getAgentAvatarPath(id)).mtimeMs;
            return `/agent-avatar/${encodeURIComponent(id)}?v=${Math.floor(mtime)}`;
          } catch (_) { return null; }
        })(),
      };
    });
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/teams', (_req, res) => {
  try {
    ensureTeam(DEFAULT_TEAM_ID);
    res.json({ teams: listTeams() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/teams', (req, res) => {
  try {
    const rawId = String(req.body?.id || req.body?.name || DEFAULT_TEAM_ID).trim();
    const name = String(req.body?.name || rawId || '').trim();
    const created = ensureTeam(rawId, { name });
    res.status(created.created ? 201 : 200).json(created.team);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/teams/:id', (req, res) => {
  try {
    const team = updateTeam(req.params.id, req.body || {});
    res.json(team);
  } catch (err) {
    if (/not found/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/teams/:id/agents/:agentId', (req, res) => {
  try {
    const result = assignAgentToTeam(req.params.agentId, req.params.id);
    res.json(result);
  } catch (err) {
    if (/unknown agent/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/activity', (req, res) => {
  try {
    const since = Number(req.query?.since);
    const limit = Number(req.query?.limit);
    const events = readTeamActivity({
      since: Number.isFinite(since) ? since : 0,
      limit: Number.isFinite(limit) ? limit : 80,
    });
    res.json({ events, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/context', (req, res) => {
  try {
    const snapshot = readAllAgentContext();
    res.json({ ...snapshot, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/metrics', (req, res) => {
  try {
    const agentId = String(req.query?.agentId || '').trim();
    const since = Number(req.query?.since);
    const until = Number(req.query?.until);
    const snapshot = readAgentMetrics({
      agentId: agentId || undefined,
      since: Number.isFinite(since) ? since : undefined,
      until: Number.isFinite(until) ? until : undefined,
    });
    res.json({ ...snapshot, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/team/retrospective', (_req, res) => {
  try {
    const workspaceDir = getWorkspaceDir();
    const cases = collectBadExchanges(workspaceDir, 7, 6);
    const metrics = readQualityMetrics();
    const summary = cases.map(c => {
      const r = c.retrospective || {};
      return {
        score: r.selfScore ?? null,
        feedbackType: r.feedbackType || (typeof r.selfScore === 'number' && r.selfScore <= 6 ? 'low-score' : 'correction'),
        userMessage: String(c.row.user || '').slice(0, 300),
        assistantMessage: String(c.row.assistant || '').slice(0, 400),
        selfReason: String(r.selfReason || '').trim(),
        implicitFeedback: String(r.implicitFeedback || '').trim(),
        ts: c.row.ts || 0,
      };
    });
    res.json({ cases: summary, metrics: metrics || {}, count: cases.length, now: Date.now() });
  } catch (err) {
    res.json({ cases: [], metrics: {}, count: 0, error: err.message, now: Date.now() });
  }
});

app.get('/api/missions', (_req, res) => {
  try {
    const snapshot = listMissions();
    res.json({ ...snapshot, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/suggestedTasks', (_req, res) => {
  try {
    const snapshot = listSuggestedTasks();
    res.json({ ...snapshot, now: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/missions', async (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const objective = String(req.body?.objective || '').trim();
    const ownerAgentId = String(req.body?.ownerAgentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
    if (!objective) {
      res.status(400).json({ error: 'objective is required' });
      return;
    }
    let draft = {
      title: title || objective,
      ownerAgentId,
      currentPlan: { steps: [] },
      contextSnapshot: '',
      memoryAnchors: [],
    };
    try {
      draft = await buildMissionDraftViaMainAgent({ title, objective, ownerAgentId });
    } catch (_) {
      // Fallback is still a valid mission with a one-step plan.
    }
    if (!Array.isArray(draft.currentPlan?.steps) || draft.currentPlan.steps.length === 0) {
      draft.currentPlan = { steps: [{ title: `Start: ${objective}`, status: 'todo' }] };
    }
    const mission = createMission({
      title: draft.title || title || objective,
      objective,
      ownerAgentId: draft.ownerAgentId || ownerAgentId,
      status: 'active',
      currentPlan: draft.currentPlan,
      contextSnapshot: draft.contextSnapshot || '',
      memoryAnchors: draft.memoryAnchors || [],
      intervalMs: req.body?.intervalMs,
    });
    res.status(201).json({ mission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/missions/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'mission id is required' });
      return;
    }
    const patch = req.body || {};
    const mission = updateMission(id, patch);
    res.json({ mission });
  } catch (err) {
    if (/not found/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/missions/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'mission id is required' });
      return;
    }
    const result = deleteMission(id);
    try { clearMissionFromAgentContext(result.title); } catch (_) {}
    // Always remove activity events tagged with this missionId (precise cleanup going forward).
    try { pruneTeamActivityForMission(id); } catch (_) {}
    // For pre-migration missions (no per-ID subfolder existed), also prune old untagged entries.
    if (!result.wasMigrated) {
      try { pruneTeamActivityLogToToday(); } catch (_) {}
    }
    res.json(result);
  } catch (err) {
    if (/not found/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/missions/:id/memory', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'mission id is required' });
      return;
    }
    const mission = getMission(id);
    if (!mission) {
      res.status(404).json({ error: `Mission not found: ${id}` });
      return;
    }
    const memory = readMissionMemory(id, { maxChars: 40_000 });
    res.json({
      missionId: id,
      title: mission.title,
      memory,
      history: Array.isArray(mission.history) ? mission.history : [],
      updatedAt: mission.updatedAt || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/missions/:id/respond', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const response = String(req.body?.response || req.body?.text || '').trim();
    if (!id) {
      res.status(400).json({ error: 'mission id is required' });
      return;
    }
    if (!response) {
      res.status(400).json({ error: 'response is required' });
      return;
    }
    const mission = respondToMissionUserInput(id, response);
    res.json({ mission });
  } catch (err) {
    if (/not found/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (/required/i.test(String(err?.message || ''))) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

// Voice transcription endpoint — accepts raw audio/webm and returns { text }
app.post('/api/transcribe', express.raw({ type: '*/*', limit: '20mb' }), async (req, res) => {
  try {
    const { getSpeechConfig, transcribe } = await import('../lib/integrations/speech-client.js');
    const config = getSpeechConfig();
    if (!config?.whisperApiKey) {
      res.status(503).json({ error: 'Whisper API key not configured. Add openai.apiKey in settings.' });
      return;
    }
    if (!req.body || !req.body.length) {
      res.status(400).json({ error: 'No audio body received' });
      return;
    }
    const tmpDir = join(getStateDir(), 'tmp');
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, `transcribe-${Date.now()}.webm`);
    writeFileSync(tmpPath, req.body);
    let text = '';
    try {
      text = await transcribe(config.whisperApiKey, tmpPath);
    } finally {
      try { (await import('fs')).unlinkSync(tmpPath); } catch (_) {}
    }
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.patch('/api/suggestedTasks/:id', (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) {
      res.status(400).json({ error: 'suggestedTask id is required' });
      return;
    }
    const patch = req.body || {};
    const suggestedTask = updateSuggestedTask(id, patch);
    res.json({ suggestedTask });
  } catch (err) {
    if (/not found/i.test(String(err?.message || ''))) {
      res.status(404).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suggestedTasks/:id/promote', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const mode = String(req.body?.mode || '').trim().toLowerCase();
    if (!id) {
      res.status(400).json({ error: 'suggestedTask id is required' });
      return;
    }
    const suggestedTask = getSuggestedTask(id);
    if (!suggestedTask) {
      res.status(404).json({ error: 'SuggestedTask not found' });
      return;
    }
    const suggestedTaskStatus = String(suggestedTask.status || 'proposed').toLowerCase();
    if (suggestedTaskStatus === 'rejected') {
      res.status(409).json({ error: 'SuggestedTask was rejected' });
      return;
    }
    if (mode !== 'mission' && mode !== 'task') {
      res.status(400).json({ error: 'mode must be mission or task' });
      return;
    }
    if (mode === 'mission') {
      const mission = createMission({
        title: suggestedTask.title,
        objective: suggestedTask.description || suggestedTask.title,
        ownerAgentId: suggestedTask.createdBy || DEFAULT_AGENT_ID,
        status: 'active',
        currentPlan: { steps: [{ title: `Start from suggestedTask: ${suggestedTask.title}`, status: 'todo' }] },
        memoryAnchors: [`suggestedTask=${suggestedTask.id}`],
      });
      const updated = updateSuggestedTask(suggestedTask.id, {
        status: 'accepted',
        relatedMissionIds: [mission.id],
        activity: [`Approved as new mission ${mission.id}`],
      });
      res.json({ suggestedTask: updated, mission });
      return;
    }
    const targetMissionId = String(req.body?.missionId || '').trim();
    if (!targetMissionId) {
      res.status(400).json({ error: 'missionId is required for task promotion' });
      return;
    }
    const mission = getMission(targetMissionId);
    if (!mission) {
      res.status(404).json({ error: 'Mission not found' });
      return;
    }
    const result = await promoteSuggestedTaskToTask(suggestedTask, targetMissionId);
    if (result.skipped) {
      res.status(409).json({ error: 'SuggestedTask already promoted to this mission', suggestedTask: result.suggestedTask, mission: result.mission });
      return;
    }
    res.json({ suggestedTask: result.suggestedTask, mission: result.mission });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/missions/:id/run', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const existing = getMission(id);
    if (!existing) {
      res.status(404).json({ error: 'Mission not found' });
      return;
    }
    const result = await runMissionTick(id, {
      runMissionTurn: (mission, prompt) =>
        runInternalAgentTurn({
          targetAgentId: mission?.ownerAgentId || DEFAULT_AGENT_ID,
          userText: prompt,
          callerAgentId: DEFAULT_AGENT_ID,
          depth: 1,
          callChain: [DEFAULT_AGENT_ID, mission?.ownerAgentId || DEFAULT_AGENT_ID],
          persistHistory: true,
        }),
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/config', (req, res) => {
  try {
    const id = req.params.id || DEFAULT_AGENT_ID;
    if (rejectInternalAgent(id, res)) return;
    const config = loadAgentConfig(id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/agents/:id/config', (req, res) => {
  try {
    const id = req.params.id || DEFAULT_AGENT_ID;
    if (rejectInternalAgent(id, res)) return;
    const patch = req.body || {};
    const config = loadAgentConfig(id);
    if (patch.llm !== undefined) config.llm = { ...(config.llm || {}), ...patch.llm };
    if (config.llm && config.llm.priorityMode !== 'custom') {
      config.llm.priorityMode = config.llm.priorityMode || 'system';
      if (Array.isArray(config.llm.models)) {
        config.llm.models = config.llm.models.map((entry) => {
          if (!entry || typeof entry !== 'object') return entry;
          const { priority, ...rest } = entry;
          return rest;
        });
      }
    } else if (config.llm && config.llm.priorityMode === 'custom' && Array.isArray(config.llm.models)) {
      let priorityIndex = config.llm.models.findIndex((entry) =>
        entry && (entry.priority === true || entry.priority === 1 || String(entry.priority).toLowerCase() === 'true'));
      if (priorityIndex < 0) priorityIndex = 0;
      config.llm.models = config.llm.models.map((entry, i) => {
        if (!entry || typeof entry !== 'object') return entry;
        if (i === priorityIndex) return { ...entry, priority: true };
        const { priority, ...rest } = entry;
        return rest;
      });
    }
    if (patch.skills !== undefined) config.skills = patch.skills;
    if (patch.title !== undefined) {
      const previousTitle = getAgentTitle(id);
      const t = normalizeAgentTitle(patch.title);
      if (t) {
        config.title = t;
        if (previousTitle && previousTitle.toLowerCase() !== t.toLowerCase()) {
          appendAgentTitleAlias(config, previousTitle);
        }
      } else {
        delete config.title;
      }
    }
    if (patch.bio !== undefined) {
      const bio = String(patch.bio || '').trim();
      if (bio) config.bio = bio;
      else delete config.bio;
    }
    if (patch.color !== undefined) {
      const color = String(patch.color || '').trim();
      if (color) config.color = color;
      else delete config.color;
    }
    if (patch.agentMessaging !== undefined) {
      config.agentMessaging = normalizeAgentMessagingPolicy({
        ...(config.agentMessaging || {}),
        ...patch.agentMessaging,
      });
    }
    if (patch.teamId !== undefined || patch.teamName !== undefined) {
      const teamId = normalizeTeamId(patch.teamId || patch.teamName || DEFAULT_TEAM_ID);
      ensureTeam(teamId, { name: patch.teamName });
      config.teamId = teamId;
    }
    if (patch.sharedUserMemory !== undefined) {
      config.sharedUserMemory = patch.sharedUserMemory !== false;
    }
    syncAgentSendSkillInConfig(config);
    saveAgentConfig(id, config);
    if (id === DEFAULT_AGENT_ID) saveConfig(config);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents', (req, res) => {
  try {
    const rawId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    if (!rawId) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const fromAgentId = typeof req.body?.fromAgentId === 'string' ? req.body.fromAgentId.trim() : '';
    const titleRaw = typeof req.body?.title === 'string' ? req.body.title : '';
    const opts = {};
    if (fromAgentId) opts.fromAgentId = fromAgentId;
    if (titleRaw.trim()) opts.title = titleRaw;
    const teamRaw = typeof req.body?.teamId === 'string' ? req.body.teamId.trim() : '';
    const teamNameRaw = typeof req.body?.teamName === 'string' ? req.body.teamName.trim() : '';
    const teamId = normalizeTeamId(teamRaw || teamNameRaw || DEFAULT_TEAM_ID);
    const teamName = teamNameRaw || teamRaw || '';
    ensureTeam(teamId, { name: teamName });
    opts.teamId = teamId;
    if (req.body?.isolated === true) opts.isolated = true;
    if (req.body?.sharedUserMemory !== undefined) opts.sharedUserMemory = req.body.sharedUserMemory !== false;
    const created = createAgent(rawId, opts);
    let config = loadAgentConfig(created.id);
    if (!config.teamId || config.teamId !== teamId) {
      config.teamId = teamId;
      saveAgentConfig(created.id, config);
    }
    if (!created.created && titleRaw.trim()) {
      const t = normalizeAgentTitle(titleRaw);
      if (t) config.title = t;
      else delete config.title;
      saveAgentConfig(created.id, config);
    }
    // Kick off avatar generation asynchronously — never block the response.
    if (created.created) {
      const agentTitle = config.title || created.id;
      generateAndSaveAgentAvatar(created.id, agentTitle).catch(() => {});
    }
    res.status(created.created ? 201 : 200).json({ id: created.id, created: created.created, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Serve an agent's avatar PNG directly. */
app.get('/agent-avatar/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || isInternalAgent(id)) { res.status(404).end(); return; }
  const avatarPath = getAgentAvatarPath(id);
  if (!existsSync(avatarPath)) { res.status(404).end(); return; }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(avatarPath);
});

/** Regenerate (or generate for the first time) an agent's avatar. */
app.post('/api/agents/:id/avatar', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (rejectInternalAgent(id, res)) return;
    const config = loadAgentConfig(id);
    const title = getAgentTitle(id) || id;
    const avatarPath = await generateAndSaveAgentAvatar(id, title, { force: true });
    if (!avatarPath) {
      res.status(503).json({ error: 'Avatar generation failed — check OpenAI API key configuration' });
      return;
    }
    res.json({ avatarUrl: `/agent-avatar/${encodeURIComponent(id)}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    const id = req.params.id || '';
    if (rejectInternalAgent(id, res)) return;
    const confirmed = req.query?.confirm === 'true' || req.body?.confirm === true;
    if (!confirmed) {
      res.status(400).json({ error: 'Deletion requires confirmation (confirm=true)' });
      return;
    }
    const result = deleteAgent(id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Group skills are now additive restrictions (deny list) on top of agent skills.

app.get('/api/group/skills', (_req, res) => {
  try {
    const groupConfig = loadGroupConfig('default');
    const deny = Array.isArray(groupConfig.skillsDeny) ? groupConfig.skillsDeny : [];
    const agentId = groupConfig.agentId || DEFAULT_AGENT_ID;
    const agentConfig = loadAgentConfig(agentId);
    const baseEnabled = Array.isArray(agentConfig.skills?.enabled) ? agentConfig.skills.enabled : DEFAULT_ENABLED;
    const enabled = baseEnabled.filter((id) => !deny.includes(id));
    const allIds = getUiSkillIds();
    const list = allIds.map((id) => ({
      id,
      enabled: enabled.includes(id),
      description: getSkillDescription(id),
    }));
    res.json({ skills: list, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/group/skills', (req, res) => {
  try {
    const { enabled } = req.body;
    if (!Array.isArray(enabled)) {
      res.status(400).json({ error: 'enabled must be an array' });
      return;
    }
    const config = loadGroupConfig('default');
    const agentId = config.agentId || DEFAULT_AGENT_ID;
    const agentConfig = loadAgentConfig(agentId);
    const baseEnabled = Array.isArray(agentConfig.skills?.enabled) ? agentConfig.skills.enabled : DEFAULT_ENABLED;
    const deny = baseEnabled.filter((id) => !enabled.includes(id));
    const saved = saveGroupConfig('default', { ...config, skillsDeny: deny });
    res.json({ enabled, restrictions: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id/config', (req, res) => {
  try {
    const id = req.params.id;
    const config = loadGroupConfig(id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/groups/:id/config', (req, res) => {
  try {
    const id = req.params.id;
    const patch = req.body || {};
    const config = loadGroupConfig(id);
    const next = { ...config };
    if (patch.agentId !== undefined) next.agentId = patch.agentId;
    if (patch.skillsDeny !== undefined) next.skillsDeny = Array.isArray(patch.skillsDeny) ? patch.skillsDeny : [];
    if (patch.tools !== undefined) next.tools = patch.tools;
    const saved = saveGroupConfig(id, next);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id/skills', (req, res) => {
  try {
    const id = req.params.id;
    const groupConfig = loadGroupConfig(id);
    const deny = Array.isArray(groupConfig.skillsDeny) ? groupConfig.skillsDeny : [];
    const agentId = resolveAgentIdForGroup(id);
    const agentConfig = loadAgentConfig(agentId);
    const baseEnabled = Array.isArray(agentConfig.skills?.enabled) ? agentConfig.skills.enabled : DEFAULT_ENABLED;
    const enabled = baseEnabled.filter((sid) => !deny.includes(sid));
    const allIds = getUiSkillIds();
    const list = allIds.map((sid) => ({
      id: sid,
      enabled: enabled.includes(sid),
      description: getSkillDescription(sid),
    }));
    res.json({ skills: list, enabled, denied: deny, agentId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/groups/:id/skills', (req, res) => {
  try {
    const id = req.params.id;
    const { enabled } = req.body;
    if (!Array.isArray(enabled)) {
      res.status(400).json({ error: 'enabled must be an array' });
      return;
    }
    const config = loadGroupConfig(id);
    const agentId = resolveAgentIdForGroup(id);
    const agentConfig = loadAgentConfig(agentId);
    const baseEnabled = Array.isArray(agentConfig.skills?.enabled) ? agentConfig.skills.enabled : DEFAULT_ENABLED;
    const deny = baseEnabled.filter((sid) => !enabled.includes(sid));
    const saved = saveGroupConfig(id, { ...config, skillsDeny: deny, agentId });
    res.json({ enabled, restrictions: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const GROUP_CHAT_LOG_DIR = 'group-chat-log';

app.get('/api/groups', (_req, res) => {
  const workspaceDir = getWorkspaceDir();
  const base = join(workspaceDir, GROUP_CHAT_LOG_DIR);
  try {
    if (!existsSync(base)) {
      console.log('[groups] base missing:', base);
      res.json({ groups: [], _path: base });
      return;
    }
    const names = readdirSync(base);
    const groups = [];
    for (const name of names) {
      if (name == null || String(name).trim() === '') continue;
      const full = join(base, name);
      try {
        if (statSync(full).isDirectory()) groups.push({ id: String(name), label: String(name) });
      } catch (_) { /* ignore per-entry errors */ }
    }
    console.log('[groups] path:', base, 'ids:', groups.map((g) => g.id));
    res.json({ groups, _path: base });
  } catch (err) {
    console.error('[groups] error:', err.message);
    res.status(500).json({ error: err.message, _path: base });
  }
});

app.get('/api/groups/:id', (req, res) => {
  try {
    const id = req.params.id;
    if (id === 'default') {
      return res.json({
        id: 'default',
        label: 'Default settings',
        usesDefaultSettings: true,
      });
    }
    const groupDir = join(getWorkspaceDir(), GROUP_CHAT_LOG_DIR, id);
    if (!existsSync(groupDir)) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const files = readdirSync(groupDir, { withFileTypes: true });
    const logFiles = files.filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => f.name);
    logFiles.sort();
    res.json({
      id,
      label: id,
      chatLogPath: join(getWorkspaceDir(), GROUP_CHAT_LOG_DIR, id),
      logFiles,
      usesDefaultSettings: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/groups/:id/history', (req, res) => {
  try {
    const id = req.params.id;
    if (id === 'default') {
      return res.json({
        id: 'default',
        firstActivity: null,
        lastActivity: null,
        totalExchanges: 0,
        logFiles: [],
        message: 'Default settings have no chat log. History is for groups that have had activity.',
      });
    }
    const groupDir = join(getWorkspaceDir(), GROUP_CHAT_LOG_DIR, id);
    if (!existsSync(groupDir)) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    const files = readdirSync(groupDir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
      .map((f) => f.name)
      .sort();
    const logFiles = [];
    let totalExchanges = 0;
    let firstTs = null;
    let lastTs = null;
    for (const name of files) {
      const path = join(groupDir, name);
      try {
        const stat = statSync(path);
        const content = readFileSync(path, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        const count = lines.length;
        totalExchanges += count;
        if (lines.length > 0) {
          try {
            const firstLine = JSON.parse(lines[0]);
            const t = firstLine?.ts ?? firstLine?.timestampMs;
            if (typeof t === 'number' && Number.isFinite(t)) {
              if (firstTs == null || t < firstTs) firstTs = t;
            }
          } catch (_) {}
          try {
            const lastLine = JSON.parse(lines[lines.length - 1]);
            const t = lastLine?.ts ?? lastLine?.timestampMs;
            if (typeof t === 'number' && Number.isFinite(t)) {
              if (lastTs == null || t > lastTs) lastTs = t;
            }
          } catch (_) {}
        }
        logFiles.push({
          name,
          mtime: stat.mtimeMs,
          mtimeISO: new Date(stat.mtimeMs).toISOString(),
          exchanges: count,
        });
      } catch (e) {
        logFiles.push({ name, error: String(e.message) });
      }
    }
    if (firstTs == null && logFiles.length > 0 && logFiles[0].mtime) {
      firstTs = logFiles[0].mtime;
    }
    if (lastTs == null && logFiles.length > 0 && logFiles[logFiles.length - 1].mtime) {
      lastTs = logFiles[logFiles.length - 1].mtime;
    }
    res.json({
      id,
      firstActivity: firstTs != null ? new Date(firstTs).toISOString() : null,
      lastActivity: lastTs != null ? new Date(lastTs).toISOString() : null,
      totalExchanges,
      logFiles,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/config', (_req, res) => {
  try {
    const config = loadConfig();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/config', (req, res) => {
  try {
    const config = loadConfig();
    const patch = req.body || {};
    const allowed = ['agents', 'llm', 'skills', 'channels', 'bio'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        config[key] = patch[key];
      }
    }
    saveConfig(config);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    const body = req.body;
    if (body == null || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Config must be a JSON object' });
      return;
    }
    saveConfig(body);
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Tide checklist ----

app.get('/api/tide/checklist', (_req, res) => {
  try {
    const config = loadConfig();
    const tide = config.tide || {};
    res.json({
      tideEnabled: !!tide.enabled,
      checklist: getTideChecklistFromConfig(config),
      lastRun: readLastChecklistRun(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tide/checklist', (req, res) => {
  try {
    const body = req.body || {};
    const config = loadConfig();
    config.tide = config.tide && typeof config.tide === 'object' ? config.tide : {};
    const current = normalizeChecklistConfig(config.tide);
    if (body.enabled !== undefined) current.enabled = !!body.enabled;
    if (body.triggers && typeof body.triggers === 'object') {
      current.triggers = { ...current.triggers, ...body.triggers };
    }
    if (Array.isArray(body.items)) {
      current.items = body.items.map((it) => {
        const label = String(it.label || 'Check').trim();
        return {
          id: String(it.id || '').trim() || 'check',
          label,
          prompt: (it.prompt != null && String(it.prompt).trim()) || label,
          enabled: it.enabled !== false,
        };
      });
      current.items = normalizeChecklistConfig({ checklist: { items: current.items } }).items;
    }
    config.tide.checklist = current;
    if (body.tideEnabled !== undefined) config.tide.enabled = !!body.tideEnabled;
    saveConfig(config);
    res.json({
      tideEnabled: !!config.tide.enabled,
      checklist: getTideChecklistFromConfig(config),
      lastRun: readLastChecklistRun(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tide/checklist/run', async (_req, res) => {
  try {
    const summary = await runTideChecklist({ manual: true, trigger: 'manual' });
    res.json({ summary, lastRun: readLastChecklistRun() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat with LLM (dashboard chat space) ----

const CHAT_SCRIPT = join(INSTALL_DIR, 'scripts', 'chat-dashboard.js');

app.post('/api/chat', (req, res) => {
  const message = req.body?.message != null ? String(req.body.message).trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const agentId = req.body?.agentId != null ? String(req.body.agentId).trim() : '';
  const voiceInput = req.body?.voiceInput === true;
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  const payload = JSON.stringify({ message, history, agentId, voiceInput });
  const child = spawn(process.execPath, [CHAT_SCRIPT], {
    cwd: INSTALL_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR, PASTURE_INSTALL_DIR: INSTALL_DIR },
  });
  let childExited = false;
  res.on('close', () => {
    if (childExited) return;
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  });
  let streamHeadersSent = false;
  function beginNdjsonStream() {
    if (streamHeadersSent) return;
    streamHeadersSent = true;
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }

  let buf = '';
  let sawTerminalLine = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    beginNdjsonStream();
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        if (o && (o.type === 'done' || o.type === 'error')) sawTerminalLine = true;
      } catch (_) {
        /* forward raw line anyway */
      }
      res.write(t + '\n');
    }
  });
  child.on('error', (err) => {
    if (!streamHeadersSent) {
      res.status(500).json({ error: err.message || String(err) });
      return;
    }
    res.write(`${JSON.stringify({ type: 'error', error: err.message || String(err) })}\n`);
    res.end();
  });
  child.on('exit', (code, signal) => {
    childExited = true;
    beginNdjsonStream();
    const rest = buf.trim();
    try {
      if (rest) {
        try {
          const o = JSON.parse(rest);
          if (o && (o.type === 'done' || o.type === 'error')) sawTerminalLine = true;
        } catch (_) {
          /* still forward */
        }
        res.write(`${rest}\n`);
        buf = '';
      }
      if (signal === 'SIGKILL' && !sawTerminalLine) {
        res.write(`${JSON.stringify({ type: 'error', error: 'Stopped.' })}\n`);
      } else if (code !== 0 && !sawTerminalLine) {
        res.write(`${JSON.stringify({ type: 'error', error: `Chat process exited (${code})` })}\n`);
      }
      res.end();
    } catch (_) {
      try {
        res.end();
      } catch (_2) {}
    }
  });
  child.stdin.end(payload, 'utf8');
});

// ---- Tests (skill test runner: list, inputs, run) ----
// Discover tests automatically: any scripts/test/<dir>/ with inputs.md and a
// matching test script anywhere under scripts/test/unit or scripts/test/e2e.

const TEST_RUN_TIMEOUT_MS = 180_000; // 3 min per test

/** Where test scripts run from (install dir, or repo override for dev). */
function getTestRoot() {
  if (process.env.PASTURE_TEST_ROOT) {
    return resolve(process.env.PASTURE_TEST_ROOT);
  }
  const installMarker = join(INSTALL_DIR, 'scripts', 'test', 'support', 'e2e-report.js');
  if (existsSync(installMarker)) return INSTALL_DIR;
  const repoMarker = join(ROOT, 'scripts', 'test', 'support', 'e2e-report.js');
  if (ROOT !== INSTALL_DIR && existsSync(repoMarker)) return ROOT;
  return INSTALL_DIR;
}

function listTestScripts(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTestScripts(p));
    } else if (/^test-.+\.(js|ps1|sh)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function getTestList() {
  const testDir = join(getTestRoot(), 'scripts', 'test');
  if (!existsSync(testDir)) return [];
  const scripts = listTestScripts(testDir);
  const scriptByBase = new Map(scripts.map((p) => [p.split(/[\\/]/).pop(), p]));
  const dirs = readdirSync(testDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .filter((d) => !['unit', 'e2e', 'support', 'fixtures'].includes(d.name))
    .map((d) => d.name)
    .sort();
  const list = [];
  for (const id of dirs) {
    const inputsPath = join(testDir, id, 'inputs.md');
    if (!existsSync(inputsPath)) continue;
    const scriptE2e = scriptByBase.get('test-' + id + '-e2e.js');
    const scriptPlain = scriptByBase.get('test-' + id + '.js');
    const scriptPath = scriptE2e || scriptPlain || null;
    if (!scriptPath) continue;
    const script = relative(getTestRoot(), scriptPath).replace(/\\/g, '/');
    let name = id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') +
      (script.endsWith('-e2e.js') ? ' E2E' : '');
    if (id === 'agent-config') name = 'Agent Config (unit, no LLM)';
    if (id === 'agent-team') name = 'Agent Team E2E (LLM + chat)';
    list.push({ id, name, script, inputsPath: 'scripts/test/' + id + '/inputs.md' });
  }
  return list;
}

function runOneTest(testId) {
  const tests = getTestList();
  const test = tests.find((t) => t.id === testId);
  if (!test) return Promise.reject(new Error(`Unknown test: ${testId}`));
  const testRoot = getTestRoot();
  const scriptPath = join(testRoot, test.script);
  if (!existsSync(scriptPath)) {
    return Promise.reject(
      new Error(
        `Script not found: ${test.script} (test root: ${testRoot}). ` +
          'If you develop from a git clone, set PASTURE_TEST_ROOT to that repo or run pasture update to refresh ~/.local/share/pastureprotocol.',
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      cwd: testRoot,
      env: {
        ...process.env,
        PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR,
        PASTURE_INSTALL_DIR: INSTALL_DIR,
        PASTURE_TEST_ROOT: testRoot,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        testId: test.id,
        name: test.name,
        exitCode: null,
        stdout,
        stderr: stderr + '\n[Timed out after ' + TEST_RUN_TIMEOUT_MS / 1000 + 's]',
        durationMs: Date.now() - start,
        timedOut: true,
      });
    }, TEST_RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        testId: test.id,
        name: test.name,
        exitCode: code,
        signal: signal || null,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        timedOut: false,
      });
    });
  });
}

app.get('/api/tests', (_req, res) => {
  try {
    res.json({ tests: getTestList() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function parseInputMessages(content) {
  if (!content) return [];
  const lines = content.split('\n');
  const groups = [];
  let cur = { group: '', messages: [] };
  let inInputs = false;
  let tableMessageCol = -1;

  function messageColIndex(cols) {
    const i = cols.findIndex((c) => /^Message$/i.test(c) || /^User says$/i.test(c));
    return i;
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (/^##\s+(Inputs|E2E scenarios|Checks|Contract checks|Unit checks|Scenarios)\b/i.test(t)) {
      if (cur.messages.length || cur.group) groups.push(cur);
      cur = { group: '', messages: [] };
      inInputs = true;
      tableMessageCol = -1;
      continue;
    }
    if (!inInputs) continue;
    if (/^##\s+/.test(t) && !/^###/.test(t)) break; // next h2 ends Inputs

    if (/^###\s+/.test(t)) {
      if (cur.messages.length || cur.group) groups.push(cur);
      cur = { group: t.replace(/^###\s*/, ''), messages: [] };
      tableMessageCol = -1;
      continue;
    }

    if (t.startsWith('|') && (/Message/i.test(t) || /User says/i.test(t) || /Scenario/i.test(t))) {
      const cols = t.split('|').map((c) => c.trim()).filter(Boolean);
      tableMessageCol = messageColIndex(cols);
      if (tableMessageCol < 0 && cols.findIndex((c) => /^Scenario$/i.test(c)) >= 0) {
        tableMessageCol = cols.findIndex((c) => /^Scenario$/i.test(c));
      }
      continue;
    }
    if (/^\|[\s\-|]+\|$/.test(t)) continue;

    if (tableMessageCol >= 0 && t.startsWith('|')) {
      const cols = t.split('|').map((c) => c.trim()).filter(Boolean);
      if (cols[tableMessageCol]) cur.messages.push(cols[tableMessageCol]);
      continue;
    }

    if (/^[-*]\s+/.test(t)) { cur.messages.push(t.replace(/^[-*]\s+/, '')); continue; }
    if (/^\d+\.\s+/.test(t)) { cur.messages.push(t.replace(/^\d+\.\s+/, '')); continue; }
  }

  if (cur.messages.length || cur.group) groups.push(cur);
  return groups;
}

app.get('/api/tests/inputs/:id', (req, res) => {
  try {
    const test = getTestList().find((t) => t.id === req.params.id);
    if (!test) {
      res.status(404).json({ error: 'Test not found' });
      return;
    }
    const p = join(getTestRoot(), test.inputsPath);
    const content = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const messages = parseInputMessages(content);
    res.json({ testId: test.id, name: test.name, content, messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tests/run', async (req, res) => {
  const testId = req.body?.testId;
  if (testId !== 'all' && !getTestList().some((t) => t.id === testId)) {
    res.status(400).json({ error: 'testId must be a test id or "all"' });
    return;
  }
  try {
    const ids = testId === 'all' ? getTestList().map((t) => t.id) : [testId];
    const results = [];
    for (const id of ids) {
      const result = await runOneTest(id);
      results.push(result);
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Soul / workspace MD files (SOUL.md, WhoAmI.md, MyHuman.md, MEMORY.md, memory/*.md) ----

const SOUL_FILE_IDS = ['SOUL.md', 'WhoAmI.md', 'MyHuman.md', 'group.md', 'MEMORY.md'];
const SOUL_FILE_LABELS = { 'SOUL.md': 'Soul', 'WhoAmI.md': 'Who am I', 'MyHuman.md': 'My human', 'group.md': 'Group rules', 'MEMORY.md': 'Memory' };

function isAllowedWorkspaceMdKey(key) {
  if (SOUL_FILE_IDS.includes(key)) return true;
  if (key.startsWith('memory/') && key.endsWith('.md')) {
    const name = key.slice(7, -3);
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
    return /^[a-zA-Z0-9_.-]+$/.test(name);
  }
  return false;
}

function getWorkspaceMdPath(key) {
  const workspaceDir = getWorkspaceDir();
  return join(workspaceDir, key);
}

app.get('/api/workspace-md', (_req, res) => {
  try {
    const workspaceDir = getWorkspaceDir();
    const list = [];
    for (const id of SOUL_FILE_IDS) {
      const path = join(workspaceDir, id);
      const exists = existsSync(path) && statSync(path).isFile();
      list.push({ id, label: SOUL_FILE_LABELS[id] || id, exists });
    }
    const memoryDir = join(workspaceDir, 'memory');
    if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
      const names = readdirSync(memoryDir);
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
        const key = `memory/${name}`;
        if (!/^[a-zA-Z0-9_.-]+$/.test(name.replace(/\.md$/, ''))) continue;
        const full = join(memoryDir, name);
        try {
          if (statSync(full).isFile()) list.push({ id: key, label: `memory/${name}`, exists: true });
        } catch (_) {}
      }
    }
    list.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
    res.json({ files: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace-md/:key', (req, res) => {
  try {
    const key = req.params.key;
    if (!isAllowedWorkspaceMdKey(key)) {
      res.status(400).json({ error: 'Invalid file key' });
      return;
    }
    const path = getWorkspaceMdPath(key);
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const label = SOUL_FILE_LABELS[key] || key;
    res.json({ id: key, label, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/workspace-md/:key', (req, res) => {
  try {
    const key = req.params.key;
    if (!isAllowedWorkspaceMdKey(key)) {
      res.status(400).json({ error: 'Invalid file key' });
      return;
    }
    const path = getWorkspaceMdPath(key);
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, 'utf8');
    syncMainAgentIdentityFileFromWorkspace(key);
    res.json({ id: key, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat logs (chat-log/*.jsonl, group-chat-log/*/*.jsonl) ----

const CHAT_LOG_DIR_NAME = 'chat-log';
const GROUP_CHAT_LOG_DIR_NAME = 'group-chat-log';
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeWorkspaceLogKey(key) {
  return String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isAllowedWorkspaceLogKey(key) {
  const k = normalizeWorkspaceLogKey(key);
  if (k.startsWith(CHAT_LOG_DAY_PREFIX)) {
    return DATE_ONLY_RE.test(k.slice(CHAT_LOG_DAY_PREFIX.length));
  }
  if (!k.endsWith('.jsonl')) return false;
  if (k.startsWith(`${CHAT_LOG_DIR_NAME}/`)) {
    const rest = k.slice(CHAT_LOG_DIR_NAME.length + 1);
    if (/^private\/[a-zA-Z0-9_.-]+\.jsonl$/.test(rest)) return true;
    return false;
  }
  if (k.startsWith(`${GROUP_CHAT_LOG_DIR_NAME}/`)) {
    const rest = k.slice(GROUP_CHAT_LOG_DIR_NAME.length + 1);
    return /^[^/]+\/\d{4}-\d{2}-\d{2}\.jsonl$/.test(rest);
  }
  return false;
}

function getWorkspaceLogPath(key) {
  return join(getWorkspaceDir(), normalizeWorkspaceLogKey(key));
}

function formatChatLogForDisplay(raw) {
  const lines = String(raw || '').split('\n').filter((l) => l.trim());
  const rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      rows.push({
        ts: row.ts,
        jid: row.jid,
        sessionId: row.sessionId,
        user: row.user != null ? String(row.user) : '',
        assistant: row.assistant != null ? String(row.assistant) : '',
      });
    } catch (_) {
      rows.push({ user: line, assistant: '' });
    }
  }
  return formatExchangesAsText(rows);
}

function listWorkspaceLogFiles(workspaceDir) {
  return collectChatLogDateEntries(workspaceDir).map(({ date, lastActivityMs }) => ({
    id: `${CHAT_LOG_DAY_PREFIX}${date}`,
    label: date,
    category: 'chat-day',
    readOnly: true,
    exists: true,
    lastActivityMs,
  }));
}

app.get('/api/workspace-logs', (_req, res) => {
  try {
    const workspaceDir = getWorkspaceDir();
    res.json({ files: listWorkspaceLogFiles(workspaceDir) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace-logs/:key', (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key || '');
    if (!isAllowedWorkspaceLogKey(key)) {
      res.status(400).json({ error: 'Invalid log file key' });
      return;
    }
    const workspaceDir = getWorkspaceDir();
    if (key.startsWith(CHAT_LOG_DAY_PREFIX)) {
      const dateStr = key.slice(CHAT_LOG_DAY_PREFIX.length);
      const content = formatExchangesAsText(readChatLogDayExchanges(workspaceDir, dateStr));
      res.json({ id: key, label: dateStr, content, readOnly: true });
      return;
    }
    const path = getWorkspaceLogPath(key);
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
    res.json({ id: key, label: key, content: formatChatLogForDisplay(raw), readOnly: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Brain (LLM knowledge graph over memory + history) ----

const BRAIN_LLM_CHUNK_CHARS = 45_000;
const BRAIN_LLM_CHUNK_OVERLAP_CHARS = 3_000;
const BRAIN_LLM_CACHE_VERSION = 12;
const BRAIN_RESPONSE_CACHE_VERSION = 11;
const BRAIN_IMPORT_MAX_INPUT_CHARS = Infinity;
const BRAIN_IMPORT_MAX_TEXT_INPUT_BYTES = Infinity;
const BRAIN_IMPORT_MAX_ZIP_INPUT_BYTES = Infinity;
const BRAIN_IMPORT_MAX_ZIP_TEXT_CHARS = Infinity;
const BRAIN_IMPORT_TEXT_EXTENSIONS = new Set(['.json', '.txt', '.md', '.csv', '.html', '.htm']);
const BRAIN_IMPORT_PROVIDERS = new Set(['chatgpt', 'grok', 'claude', 'gemini', 'perplexity', 'copilot', 'other']);
const BRAIN_INPUT_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an',
  'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'done', 'down', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here',
  'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only',
  'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom',
  'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself',
  'yourselves',
]);
const brainCloudCache = new Map();
const brainCloudBuilds = new Map();
const brainBuildProgress = new Map();

function brainDebugLog(event, details = {}) {
  const row = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  const line = `[brain] ${JSON.stringify(row)}`;
  console.log(line);
  try {
    const path = join(getStateDir(), 'brain-debug.log');
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (_) {}
}

let dashboardProcessExitLogged = false;

function logDashboardProcessExit(event, details = {}) {
  if (dashboardProcessExitLogged && event === 'dashboard_process_exit') return;
  if (event === 'dashboard_process_exit') dashboardProcessExitLogged = true;
  brainDebugLog(event, {
    pid: process.pid,
    ...details,
  });
}

process.on('SIGTERM', () => {
  logDashboardProcessExit('dashboard_process_signal', { signal: 'SIGTERM' });
  process.exit(0);
});

process.on('SIGINT', () => {
  logDashboardProcessExit('dashboard_process_signal', { signal: 'SIGINT' });
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logDashboardProcessExit('dashboard_process_uncaught_exception', {
    error: err?.message || String(err),
    stack: String(err?.stack || '').slice(0, 4000),
  });
  console.error(err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  brainDebugLog('dashboard_process_unhandled_rejection', {
    pid: process.pid,
    error: reason?.message || String(reason),
    stack: String(reason?.stack || '').slice(0, 4000),
  });
});

process.on('exit', (code) => {
  logDashboardProcessExit('dashboard_process_exit', { code });
});

function brainHashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function brainHashBuffer(value) {
  return createHash('sha256').update(value || Buffer.alloc(0)).digest('hex');
}

function brainCurrentLocalDate() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: getResolvedTimezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeBrainProgressId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(id) ? id : '';
}

function setBrainBuildProgress(id, patch) {
  if (!id) return;
  const prev = brainBuildProgress.get(id) || {};
  brainBuildProgress.set(id, {
    ...prev,
    ...patch,
    updatedAtMs: Date.now(),
  });
}

function finishBrainBuildProgress(id, patch = {}) {
  if (!id) return;
  setBrainBuildProgress(id, { ...patch, done: true });
  setTimeout(() => brainBuildProgress.delete(id), 5 * 60 * 1000).unref?.();
}

function getActiveBrainBuildProgress() {
  let active = null;
  for (const [id, progress] of brainBuildProgress.entries()) {
    if (!progress || progress.done) continue;
    const updatedAtMs = Number(progress.updatedAtMs || 0);
    if (!active || updatedAtMs > active.updatedAtMs) {
      active = { id, ...progress, updatedAtMs };
    }
  }
  return active;
}

function brainLlmCacheDir() {
  return join(getStateDir(), 'brain-llm-cache', `v${BRAIN_LLM_CACHE_VERSION}`);
}

function brainLlmChunkCachePath(key) {
  return join(brainLlmCacheDir(), key.slice(0, 2), `${key}.json`);
}

function brainResponseCacheDir() {
  return join(getStateDir(), 'brain-response-cache', `v${BRAIN_RESPONSE_CACHE_VERSION}`);
}

function brainResponseCachePath(key) {
  return join(brainResponseCacheDir(), key.slice(0, 2), `${key}.json`);
}

function readBrainResponseCache(key) {
  const path = brainResponseCachePath(key);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const payload = parsed && parsed.payload;
    if (!payload || !Array.isArray(payload.terms) || !Array.isArray(payload.connections)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function brainPayloadHasTerms(payload) {
  return Array.isArray(payload?.terms) && payload.terms.length > 0;
}

function brainPayloadHadNoCorpus(payload) {
  return Number(payload?.stats?.chars || 0) === 0;
}

function brainPayloadIsReusable(payload) {
  return !!payload && (brainPayloadHasTerms(payload) || brainPayloadHadNoCorpus(payload));
}

function readLatestBrainResponseCache({ requireTerms = false } = {}) {
  const root = brainResponseCacheDir();
  let best = null;
  function visit(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch (_) {
        continue;
      }
      if (st.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const payload = parsed?.payload;
        if (!brainPayloadIsReusable(payload)) continue;
        if (requireTerms && !brainPayloadHasTerms(payload)) continue;
        const cachedAtMs = Number(parsed?.cachedAtMs || payload?.updatedAtMs || st.mtimeMs) || st.mtimeMs;
        if (!best || cachedAtMs > best.cachedAtMs) {
          best = { payload, cachedAtMs, path };
        }
      } catch (_) {}
    }
  }
  visit(root);
  return best;
}

function readLatestCompatibleBrainResponseCache() {
  return readLatestBrainResponseCache({ requireTerms: true });
}

function brainFallbackPayloadForResponse(fallback) {
  if (!fallback?.payload) return null;
  return fallback.payload;
}

function writeBrainResponseCache(key, payload) {
  if (!payload || !Array.isArray(payload.terms) || !Array.isArray(payload.connections)) return;
  const path = brainResponseCachePath(key);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    cachedAtMs: Date.now(),
    payload,
  }, null, 2), 'utf8');
}

function readBrainLlmChunkCache(key) {
  const path = brainLlmChunkCachePath(key);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.terms) || !Array.isArray(parsed?.connections)) {
      brainDebugLog('chunk_cache_invalid', { key, reason: 'bad_shape' });
      return null;
    }
    return parsed;
  } catch (_) {
    brainDebugLog('chunk_cache_invalid', { key, reason: 'read_failed' });
    return null;
  }
}

function writeBrainLlmChunkCache(key, payload) {
  const path = brainLlmChunkCachePath(key);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify({
    cachedAtMs: Date.now(),
    ...payload,
  }, null, 2), 'utf8');
}

function markBrainImportChunkProcessed(label, chunkIndex, cacheKey, status = 'processed') {
  const parts = String(label || '').split('/');
  if (parts.length < 5 || parts[0] !== 'brain-imports' || parts[3] !== 'conversations') return;
  const [, provider, importId, , fileName] = parts;
  const manifestPath = join(brainImportsDir(), provider, importId, 'manifest.json');
  try {
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.processing = manifest.processing && typeof manifest.processing === 'object' ? manifest.processing : {};
    const fileKey = `conversations/${fileName}`;
    const fileState = manifest.processing[fileKey] && typeof manifest.processing[fileKey] === 'object'
      ? manifest.processing[fileKey]
      : { chunks: {} };
    fileState.chunks = fileState.chunks && typeof fileState.chunks === 'object' ? fileState.chunks : {};
    fileState.chunks[String(chunkIndex || 0)] = {
      status,
      cacheKey,
      processedAt: new Date().toISOString(),
    };
    fileState.status = Object.values(fileState.chunks).some((chunk) => chunk.status === 'failed') ? 'partial' : 'processed';
    fileState.updatedAt = new Date().toISOString();
    manifest.processing[fileKey] = fileState;
    manifest.status = 'processed';
    manifest.updatedAt = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (_) {}
}

function normalizeBrainImportProvider(value) {
  const v = String(value || 'other').trim().toLowerCase();
  return BRAIN_IMPORT_PROVIDERS.has(v) ? v : 'other';
}

function brainImportProviderLabel(provider) {
  return {
    chatgpt: 'ChatGPT',
    grok: 'Grok',
    claude: 'Claude',
    gemini: 'Gemini',
    perplexity: 'Perplexity',
    copilot: 'Copilot',
    other: 'Other chat service',
  }[provider] || 'Other chat service';
}

function safeBrainPathPart(value, fallback = 'item') {
  const safe = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || fallback;
}

function brainImportsDir(workspaceDir = getWorkspaceDir()) {
  return join(workspaceDir, 'brain-imports');
}

function readValidBrainImportManifest(importRoot) {
  const manifestPath = join(importRoot, 'manifest.json');
  try {
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const status = String(manifest.status || '');
    if (status !== 'extracted' && status !== 'processed') return null;
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const filesExist = files.length > 0 && files.every((rel) => existsSync(join(importRoot, rel)));
    return filesExist ? manifest : null;
  } catch (_) {
    return null;
  }
}

function markBrainImportSuperseded(importRoot, supersededBy) {
  const manifestPath = join(importRoot, 'manifest.json');
  try {
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.status = 'superseded';
    manifest.supersededBy = supersededBy;
    manifest.supersededAt = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (_) {}
}

function brainImportId(provider, text) {
  return brainHashText(`${provider}\n${text}`).slice(0, 24);
}

function brainImportPayloadSignature(provider, contentHash) {
  return brainImportId(provider, contentHash);
}

function isBrainZipFileName(name) {
  return /\.zip$/i.test(String(name || '').trim());
}

function maxBrainImportInputBytes(rawKind) {
  return rawKind === 'zip' ? BRAIN_IMPORT_MAX_ZIP_INPUT_BYTES : BRAIN_IMPORT_MAX_TEXT_INPUT_BYTES;
}

function isChatGptConversationsJsonName(name) {
  return /(^|\/)conversations\.json$/i.test(String(name || ''));
}

function isChatGptSplitConversationsJsonName(name) {
  return /(^|\/)conversations-\d+\.json$/i.test(String(name || ''));
}

function isChatGptConversationJsonName(name) {
  return isChatGptConversationsJsonName(name) || isChatGptSplitConversationsJsonName(name);
}

function isGrokBackendJsonName(name) {
  return /(^|\/)prod-grok-backend\.json$/i.test(String(name || ''));
}

function isReadableBrainImportEntry(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower || lower.endsWith('/')) return false;
  if (lower.includes('__macosx/') || lower.includes('/.')) return false;
  return Array.from(BRAIN_IMPORT_TEXT_EXTENSIONS).some((ext) => lower.endsWith(ext));
}

function brainZipEntryPriority(name) {
  if (isGrokBackendJsonName(name)) return 0;
  if (isChatGptConversationsJsonName(name)) return 1;
  if (isChatGptSplitConversationsJsonName(name)) return 2;
  if (/\.json$/i.test(String(name || ''))) return 5;
  if (/\.md$/i.test(String(name || ''))) return 10;
  if (/\.txt$/i.test(String(name || ''))) return 11;
  if (/\.csv$/i.test(String(name || ''))) return 12;
  if (/\.html?$/i.test(String(name || ''))) return 20;
  return 30;
}

function focusBrainZipEntryNames(names) {
  const readable = names.filter(isReadableBrainImportEntry);
  const grokNames = readable.filter(isGrokBackendJsonName);
  if (grokNames.length) return grokNames.sort((a, b) => a.localeCompare(b));

  const chatGptNames = readable.filter(isChatGptConversationJsonName);
  if (chatGptNames.length) return chatGptNames.sort((a, b) => a.localeCompare(b));

  return readable.sort((a, b) => {
    const priorityDiff = brainZipEntryPriority(a) - brainZipEntryPriority(b);
    return priorityDiff || a.localeCompare(b);
  });
}

function stripHtmlForBrainImport(text) {
  return String(text || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function decodeBrainImportPayload(body) {
  const filename = String(body?.filename || '').trim().slice(0, 180);
  const provider = normalizeBrainImportProvider(body?.provider);
  const contentBase64 = String(body?.contentBase64 || '');
  if (contentBase64) {
    const rawBuffer = Buffer.from(contentBase64, 'base64');
    if (!rawBuffer.length) throw new Error('Choose an export file or paste a transcript first.');
    const rawKind = isBrainZipFileName(filename) || String(body?.contentType || '').toLowerCase().includes('zip') ? 'zip' : 'binary';
    const maxBytes = maxBrainImportInputBytes(rawKind);
    if (rawBuffer.length > maxBytes) {
      const sizeMb = Math.round(maxBytes / 1024 / 1024);
      const err = new Error(`Import is too large for the dashboard. Try an export under ${sizeMb} MB.`);
      err.statusCode = 413;
      throw err;
    }
    return {
      provider,
      filename,
      rawBuffer,
      rawKind,
      contentHash: brainHashBuffer(rawBuffer),
    };
  }

  const text = String(body?.content || '');
  if (!text.trim()) throw new Error('Choose an export file or paste a transcript first.');
  if (text.length > BRAIN_IMPORT_MAX_INPUT_CHARS) {
    const err = new Error('Import is too large for the dashboard. Try a smaller export file.');
    err.statusCode = 413;
    throw err;
  }
  return {
    provider,
    filename,
    rawText: text,
    rawBuffer: Buffer.from(text, 'utf8'),
    rawKind: 'text',
    contentHash: brainHashText(text),
  };
}

function extractBrainZipTextEntriesFromPath(zipPath) {
  const listing = execFileSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const allNames = listing.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const ordered = focusBrainZipEntryNames(allNames);
  const structuredOnly = ordered.length > 0 && ordered.every((name) => isGrokBackendJsonName(name) || isChatGptConversationJsonName(name));
  const entries = [];
  let remaining = BRAIN_IMPORT_MAX_ZIP_TEXT_CHARS;
  for (let i = 0; i < ordered.length; i++) {
    const name = ordered[i];
    if (remaining <= 0) {
      if (structuredOnly) {
        const sizeMb = Math.round(BRAIN_IMPORT_MAX_ZIP_TEXT_CHARS / 1024 / 1024);
        const err = new Error(`Chat export text is too large after extraction. Try a split export under ${sizeMb} MB of conversation JSON.`);
        err.statusCode = 413;
        throw err;
      }
      break;
    }
    const buf = execFileSync('unzip', ['-p', zipPath, name], {
      encoding: 'buffer',
      maxBuffer: Math.min(BRAIN_IMPORT_MAX_ZIP_TEXT_CHARS + 1024 * 1024, remaining + 1024 * 1024),
    });
    let text = buf.toString('utf8').replace(/\u0000/g, '').trim();
    if (!text) continue;
    if (/\.html?$/i.test(name)) text = stripHtmlForBrainImport(text);
    if (!text) continue;
    if (text.length > remaining) {
      if (structuredOnly || isChatGptConversationJsonName(name) || isGrokBackendJsonName(name)) {
        const sizeMb = Math.round(BRAIN_IMPORT_MAX_ZIP_TEXT_CHARS / 1024 / 1024);
        const err = new Error(`Chat export text is too large after extraction. Try a split export under ${sizeMb} MB of conversation JSON.`);
        err.statusCode = 413;
        throw err;
      }
      text = text.slice(0, remaining);
    }
    entries.push({ name, text });
    remaining -= text.length;
  }
  return entries;
}

function extractBrainZipTextEntries(zipBuffer) {
  const tmpRoot = join(getStateDir(), 'tmp');
  if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
  const tmpDir = mkdtempSync(join(tmpRoot, 'brain-import-'));
  const zipPath = join(tmpDir, 'import.zip');
  try {
    writeFileSync(zipPath, zipBuffer);
    return extractBrainZipTextEntriesFromPath(zipPath);
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function buildBrainImportTextFromPayload(payload) {
  if (payload.rawKind !== 'zip') {
    if (payload.rawText != null) return payload.rawText;
    if (payload.rawBuffer) return payload.rawBuffer.toString('utf8');
    if (payload.rawPath) return readFileSync(payload.rawPath, 'utf8');
    return '';
  }
  const entries = payload.rawPath
    ? extractBrainZipTextEntriesFromPath(payload.rawPath)
    : extractBrainZipTextEntries(payload.rawBuffer);
  if (!entries.length) {
    const err = new Error('No readable chat export files were found inside that ZIP.');
    err.statusCode = 400;
    throw err;
  }
  const grokBackend = entries.find((entry) => /(^|\/)prod-grok-backend\.json$/i.test(entry.name));
  if (grokBackend) {
    payload.detectedProvider = 'grok';
    return grokBackend.text;
  }
  const conversationsJson = entries.find((entry) => isChatGptConversationsJsonName(entry.name));
  if (conversationsJson) {
    payload.detectedProvider = 'chatgpt';
    return conversationsJson.text;
  }
  const splitConversationEntries = entries.filter((entry) => isChatGptSplitConversationsJsonName(entry.name));
  if (splitConversationEntries.length) {
    const conversations = [];
    for (const entry of splitConversationEntries) {
      let parsed;
      try {
        parsed = JSON.parse(entry.text);
      } catch (err) {
        const e = new Error(`Could not parse ${entry.name} as ChatGPT conversation JSON.`);
        e.statusCode = 400;
        throw e;
      }
      const rows = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.conversations)
          ? parsed.conversations
          : [];
      for (const row of rows) conversations.push(row);
    }
    if (conversations.length) {
      payload.detectedProvider = 'chatgpt';
      return JSON.stringify(conversations);
    }
  }
  return entries.map((entry) => `# File: ${entry.name}\n\n${entry.text}`).join('\n\n');
}

function stringifyChatContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyChatContent).filter(Boolean).join('\n').trim();
  if (typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text.trim();
  if (typeof value.content === 'string') return value.content.trim();
  if (typeof value.value === 'string') return value.value.trim();
  if (Array.isArray(value.parts)) return value.parts.map(stringifyChatContent).filter(Boolean).join('\n').trim();
  if (Array.isArray(value.content)) return value.content.map(stringifyChatContent).filter(Boolean).join('\n').trim();
  return '';
}

function normalizeChatRole(value) {
  const role = String(value || 'message').trim().toLowerCase();
  if (role === 'user' || role === 'human') return 'User';
  if (role === 'assistant' || role === 'bot' || role === 'model' || role === 'grok') return 'Assistant';
  if (role === 'system') return 'System';
  if (role === 'tool' || role === 'function') return 'Tool';
  return 'Message';
}

function normalizeConversationTitle(value, fallback) {
  const title = String(value || '').trim().replace(/\s+/g, ' ');
  return title ? title.slice(0, 120) : fallback;
}

function extractChatGptConversation(conv, index) {
  const title = normalizeConversationTitle(conv?.title, `Conversation ${index + 1}`);
  const rows = [];
  if (conv?.mapping && typeof conv.mapping === 'object') {
    for (const node of Object.values(conv.mapping)) {
      const msg = node?.message;
      if (!msg) continue;
      const role = normalizeChatRole(msg.author?.role);
      const text = stringifyChatContent(msg.content?.parts || msg.content);
      if (!text) continue;
      rows.push({
        role,
        text,
        ts: Number(msg.create_time || node?.create_time || 0),
      });
    }
  }
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { title, messages: rows.map(({ role, text }) => ({ role, text })) };
}

function grokDateMs(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const longValue = value?.$date?.$numberLong ?? value?.$numberLong;
  if (longValue != null) {
    const n = Number(longValue);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function extractGrokConversation(item, index) {
  const conv = item?.conversation && typeof item.conversation === 'object' ? item.conversation : item;
  const title = normalizeConversationTitle(conv?.title || conv?.summary, `Grok conversation ${index + 1}`);
  const responseList = Array.isArray(item?.responses)
    ? item.responses
    : Array.isArray(conv?.responses)
      ? conv.responses
      : Array.isArray(conv?.messages)
        ? conv.messages
        : [];
  const rows = responseList
    .map((wrapper) => {
      const response = wrapper?.response && typeof wrapper.response === 'object' ? wrapper.response : wrapper;
      const text = stringifyChatContent(response?.message ?? response?.content ?? response?.text);
      if (!text) return null;
      return {
        role: normalizeChatRole(response?.sender || response?.role || response?.author),
        text,
        ts: grokDateMs(response?.create_time || response?.created_at || response?.timestamp),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return { title, messages: rows.map(({ role, text }) => ({ role, text })) };
}

function isGrokConversationExportItem(item) {
  const conv = item?.conversation && typeof item.conversation === 'object' ? item.conversation : item;
  return !!(conv && typeof conv === 'object' && (Array.isArray(item?.responses) || Array.isArray(conv?.responses)));
}

function extractGenericConversation(conv, index) {
  const title = normalizeConversationTitle(conv?.title || conv?.name || conv?.conversation_title, `Conversation ${index + 1}`);
  const messageList = Array.isArray(conv?.messages)
    ? conv.messages
    : Array.isArray(conv?.chat_messages)
      ? conv.chat_messages
      : Array.isArray(conv?.turns)
        ? conv.turns
        : [];
  const messages = messageList
    .map((msg) => {
      const role = normalizeChatRole(msg?.role || msg?.sender || msg?.author || msg?.from);
      const text = stringifyChatContent(msg?.content ?? msg?.text ?? msg?.message ?? msg?.parts);
      return text ? { role, text } : null;
    })
    .filter(Boolean);
  return { title, messages };
}

function extractBrainImportConversations(provider, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {}

  if (parsed) {
    const root = Array.isArray(parsed) ? parsed : Array.isArray(parsed.conversations) ? parsed.conversations : null;
    if (root) {
      const conversations = root.map((conv, index) => {
        if (provider === 'grok' || isGrokConversationExportItem(conv)) return extractGrokConversation(conv, index);
        if (conv?.mapping) return extractChatGptConversation(conv, index);
        return extractGenericConversation(conv, index);
      }).filter((conv) => conv.messages.length > 0);
      if (conversations.length) return conversations;
    }
    if (provider === 'grok' || isGrokConversationExportItem(parsed)) {
      const grokSingle = extractGrokConversation(parsed, 0);
      if (grokSingle.messages.length) return [grokSingle];
    }
    const single = extractGenericConversation(parsed, 0);
    if (single.messages.length) return [single];
  }

  return [{
    title: `${brainImportProviderLabel(provider)} import`,
    messages: [{ role: 'Transcript', text: trimmed }],
  }];
}

function renderBrainConversationMarkdown({ provider, originalName, conversation, index, importId }) {
  const label = brainImportProviderLabel(provider);
  const title = normalizeConversationTitle(conversation?.title, `Conversation ${index + 1}`);
  const lines = [
    `# ${title}`,
    '',
    `Import: ${importId}`,
    `Source: ${label}`,
    originalName ? `Original file: ${originalName}` : '',
    `Conversation index: ${index + 1}`,
    `Messages: ${conversation.messages.length}`,
    '',
  ].filter((line) => line !== '');

  for (const msg of conversation.messages) {
    lines.push(`**${msg.role}:**`);
    lines.push(String(msg.text || '').trim());
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

function stripBrainInputStopWords(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  let token = '';
  let cleaned = '';

  function isTokenChar(code) {
    return (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 39 ||
      code === 45 ||
      code === 95;
  }

  function flushToken() {
    if (!token) return;
    if (!BRAIN_INPUT_STOP_WORDS.has(token.toLowerCase())) {
      cleaned += token;
    }
    token = '';
  }

  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (isTokenChar(code)) {
      token += ch;
    } else {
      flushToken();
      cleaned += ch;
    }
  }
  flushToken();
  return cleaned.trim();
}

function pushBrainCorpusChunk(out, chunk) {
  if (!chunk) return;
  const text = stripBrainInputStopWords(chunk.text);
  if (!text) return;
  out.push({
    source: chunk.source,
    label: String(chunk.label || chunk.source || '').slice(0, 120),
    role: chunk.role ? String(chunk.role).slice(0, 40) : '',
    ts: Number(chunk.ts || 0) || 0,
    text,
  });
}

function brainCorpusChunkText(chunk) {
  return String(chunk?.text || '').trim();
}

function formatBrainCorpusItemForLlm(item) {
  const text = brainCorpusChunkText(item);
  if (!text) return '';
  const header = [
    '---',
    `Source: ${String(item?.source || 'unknown')}`,
    `Label: ${String(item?.label || item?.source || 'unknown')}`,
    item?.role ? `Role: ${String(item.role)}` : '',
    item?.ts ? `Timestamp: ${Number(item.ts)}` : '',
    '---',
  ].filter(Boolean).join('\n');
  return `${header}\n${text}`;
}

function collectBrainCorpus() {
  const workspaceDir = getWorkspaceDir();
  const stats = { memoryFiles: 0, noteFiles: 0, importFiles: 0, historyDays: 0, exchanges: 0, chars: 0 };
  const sourceSpecs = [
    {
      collect() {
        const items = [];
        for (const name of ['MEMORY.md', 'memory.md']) {
          const full = join(workspaceDir, name);
          try {
            if (existsSync(full) && statSync(full).isFile()) {
              const text = readFileSync(full, 'utf8');
              stats.memoryFiles += 1;
              items.push({ source: 'memory', label: name, text });
            }
          } catch (_) {}
        }
        return items;
      },
    },
    {
      collect() {
        const items = [];
        const memoryDir = join(workspaceDir, 'memory');
        try {
          if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
            for (const name of readdirSync(memoryDir).sort()) {
              if (!name.endsWith('.md')) continue;
              if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
              const full = join(memoryDir, name);
              if (!statSync(full).isFile()) continue;
              const text = readFileSync(full, 'utf8');
              stats.noteFiles += 1;
              items.push({ source: 'notes', label: `memory/${name}`, text });
            }
          }
        } catch (_) {}
        return items;
      },
    },
    {
      collect() {
        const items = [];
        const importsDir = brainImportsDir(workspaceDir);
        try {
          if (existsSync(importsDir) && statSync(importsDir).isDirectory()) {
            for (const providerName of readdirSync(importsDir).sort()) {
              if (providerName.startsWith('.')) continue;
              const providerDir = join(importsDir, providerName);
              if (!statSync(providerDir).isDirectory()) continue;
              for (const importName of readdirSync(providerDir).sort()) {
                if (importName.startsWith('.')) continue;
                const importRoot = join(providerDir, importName);
                if (!readValidBrainImportManifest(importRoot)) continue;
                const conversationsDir = join(importRoot, 'conversations');
                if (!existsSync(conversationsDir) || !statSync(conversationsDir).isDirectory()) continue;
                for (const name of readdirSync(conversationsDir).sort()) {
                  if (!name.endsWith('.md')) continue;
                  const full = join(conversationsDir, name);
                  if (!statSync(full).isFile()) continue;
                  const text = readFileSync(full, 'utf8');
                  if (!text) continue;
                  stats.importFiles += 1;
                  items.push({
                    source: 'notes',
                    label: `brain-imports/${providerName}/${importName}/conversations/${name}`,
                    text,
                  });
                }
              }
            }
          }
        } catch (_) {}
        return items;
      },
    },
    {
      collect() {
        const items = [];
        for (const day of collectChatLogDateEntries(workspaceDir)) {
          const exchanges = readChatLogDayExchanges(workspaceDir, day.date);
          if (!exchanges.length) continue;
          stats.historyDays += 1;
          stats.exchanges += exchanges.length;
          for (const ex of exchanges) {
            const parts = [];
            const userText = String(ex?.user || '').trim();
            const assistantText = String(ex?.assistant || '').trim();
            if (userText) parts.push(`User:\n${userText}`);
            if (assistantText) parts.push(`Assistant:\n${assistantText}`);
            const text = parts.join('\n\n').trim();
            if (!text) continue;
            items.push({
              source: 'history',
              label: day.date,
              ts: ex.ts,
              text,
            });
          }
        }
        return items;
      },
    }
  ];

  const corpus = [];
  for (const spec of sourceSpecs) {
    for (const item of spec.collect()) {
      pushBrainCorpusChunk(corpus, item);
    }
  }
  stats.chars = corpus.reduce((sum, chunk) => sum + brainCorpusChunkText(chunk).length, 0);
  return { corpus, stats };
}

function splitBrainCorpusForLlm(corpus) {
  const chunks = [];
  const stride = Math.max(1, BRAIN_LLM_CHUNK_CHARS - BRAIN_LLM_CHUNK_OVERLAP_CHARS);
  const text = (corpus || [])
    .map(formatBrainCorpusItemForLlm)
    .filter(Boolean)
    .join('\n\n');
  if (!text.trim()) return chunks;
  for (let start = 0, index = 0; start < text.length; start += stride, index++) {
    const slice = text.slice(start, start + BRAIN_LLM_CHUNK_CHARS).trim();
    if (!slice) continue;
    chunks.push({
      source: 'combined',
      label: 'combined brain corpus',
      role: '',
      ts: 0,
      chunkIndex: index,
      text: slice,
    });
  }
  return chunks;
}

function brainLlmChunkCacheKey(chunk) {
  const historyDate = String(chunk.source || '') === 'history' && /^\d{4}-\d{2}-\d{2}$/.test(String(chunk.label || ''))
    ? String(chunk.label || '')
    : '';
  const historyLifecycle = historyDate
    ? (historyDate === brainCurrentLocalDate() ? 'open' : 'final')
    : '';
  return brainHashText(JSON.stringify({
    version: BRAIN_LLM_CACHE_VERSION,
    source: chunk.source || '',
    label: chunk.label || '',
    role: chunk.role || '',
    historyLifecycle,
    ts: chunk.ts || 0,
    chunkIndex: chunk.chunkIndex || 0,
    textHash: brainHashText(chunk.text || ''),
  }));
}

function brainResponseCacheKey({ chunks }) {
  return brainHashText(JSON.stringify({
    version: BRAIN_RESPONSE_CACHE_VERSION,
    llmVersion: BRAIN_LLM_CACHE_VERSION,
    chunkKeys: (chunks || []).map((chunk) => brainLlmChunkCacheKey(chunk)),
  }));
}

function normalizeBrainDisplayKey(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.toLowerCase();
}

function mergeBrainSources(target, sources) {
  for (const source of sources || []) {
    const s = String(source || '').trim();
    if (s) target.add(s);
  }
}

async function buildLlmBrainGraph(corpus, { onProgress, force = false, chunks: providedChunks = null } = {}) {
  const chunks = Array.isArray(providedChunks) ? providedChunks : splitBrainCorpusForLlm(corpus);
  const termMap = new Map();
  const edgeMap = new Map();
  const stats = { chunks: chunks.length, cacheHits: 0, generated: 0, empty: 0, failed: 0 };
  const fileChunkTotals = new Map();
  const fileChunkDone = new Map();
  let doneFiles = 0;

  brainDebugLog('raw_build_start', {
    force,
    corpusItems: Array.isArray(corpus) ? corpus.length : 0,
    chunks: chunks.length,
  });

  for (const chunk of chunks) {
    const fileKey = `${chunk.source || ''}:${chunk.label || ''}`;
    fileChunkTotals.set(fileKey, (fileChunkTotals.get(fileKey) || 0) + 1);
  }

  if (onProgress) {
    onProgress({
      phase: 'processing',
      doneChunks: 0,
      totalChunks: chunks.length,
      doneFiles: 0,
      totalFiles: fileChunkTotals.size,
      remainingFiles: fileChunkTotals.size,
      cacheHits: 0,
      generated: 0,
      failed: 0,
    });
  }

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    const cacheKey = brainLlmChunkCacheKey(chunk);
    const fileKey = `${chunk.source || ''}:${chunk.label || ''}`;
    let graph = force ? null : readBrainLlmChunkCache(cacheKey);
    if (force && chunkIndex === 0) brainDebugLog('chunk_cache_bypassed', { reason: 'force_refresh' });
    if (graph) {
      stats.cacheHits += 1;
      brainDebugLog('chunk_cache_hit', {
        index: chunkIndex,
        cacheKey: cacheKey.slice(0, 16),
        terms: Array.isArray(graph.terms) ? graph.terms.length : 0,
        connections: Array.isArray(graph.connections) ? graph.connections.length : 0,
      });
      markBrainImportChunkProcessed(chunk.label, chunk.chunkIndex, cacheKey, 'cached');
    } else {
      brainDebugLog('chunk_llm_start', {
        index: chunkIndex,
        cacheKey: cacheKey.slice(0, 16),
        source: chunk.source,
        label: String(chunk.label || '').slice(0, 120),
        chars: String(chunk.text || '').length,
      });
      graph = await generateBrainChunkGraph({ chunk });
      if (!graph) {
        stats.failed += 1;
        brainDebugLog('chunk_llm_failed', {
          index: chunkIndex,
          cacheKey: cacheKey.slice(0, 16),
          source: chunk.source,
          label: String(chunk.label || '').slice(0, 120),
        });
        graph = { terms: [], connections: [] };
        markBrainImportChunkProcessed(chunk.label, chunk.chunkIndex, cacheKey, 'failed');
      } else {
        const graphTerms = Array.isArray(graph.terms) ? graph.terms : [];
        const graphConnections = Array.isArray(graph.connections) ? graph.connections : [];
        if (!graphTerms.length && !graphConnections.length) {
          stats.empty += 1;
          brainDebugLog('chunk_generated_empty', {
            index: chunkIndex,
            source: chunk.source,
            label: String(chunk.label || '').slice(0, 120),
            chars: String(chunk.text || '').length,
          });
        }
        writeBrainLlmChunkCache(cacheKey, {
          source: chunk.source,
          label: chunk.label,
          role: chunk.role,
          chunkIndex: chunk.chunkIndex,
          textHash: brainHashText(chunk.text || ''),
          terms: graphTerms,
          connections: graphConnections,
        });
        brainDebugLog('chunk_llm_complete', {
          index: chunkIndex,
          cacheKey: cacheKey.slice(0, 16),
          terms: graphTerms.length,
          connections: graphConnections.length,
          empty: !graphTerms.length && !graphConnections.length,
        });
        stats.generated += 1;
        markBrainImportChunkProcessed(chunk.label, chunk.chunkIndex, cacheKey, 'processed');
      }
    }

    const fileDone = (fileChunkDone.get(fileKey) || 0) + 1;
    fileChunkDone.set(fileKey, fileDone);
    if (fileDone === fileChunkTotals.get(fileKey)) doneFiles += 1;

    if (onProgress) {
      onProgress({
        phase: 'processing',
        currentFile: chunk.label || chunk.source || '',
        doneChunks: chunkIndex + 1,
        totalChunks: chunks.length,
        doneFiles,
        totalFiles: fileChunkTotals.size,
        remainingFiles: Math.max(0, fileChunkTotals.size - doneFiles),
        cacheHits: stats.cacheHits,
        generated: stats.generated,
        failed: stats.failed,
      });
    }

    for (const term of graph.terms || []) {
      const key = normalizeBrainDisplayKey(term.text);
      if (!key) continue;
      const weight = Math.max(1, Math.min(100, Number(term.weight) || 1));
      const prev = termMap.get(key) || {
        text: term.text,
        score: 0,
        maxWeight: 0,
        mentions: 0,
        sources: new Set(),
      };
      if (weight > prev.maxWeight) {
        prev.text = term.text;
        prev.maxWeight = weight;
      }
      prev.score += weight;
      prev.mentions += 1;
      mergeBrainSources(prev.sources, term.sources && term.sources.length ? term.sources : [chunk.source]);
      termMap.set(key, prev);
    }

    for (const connection of graph.connections || []) {
      const fromKey = normalizeBrainDisplayKey(connection.from);
      const toKey = normalizeBrainDisplayKey(connection.to);
      if (!fromKey || !toKey || fromKey === toKey) continue;
      const ordered = fromKey < toKey ? [fromKey, toKey] : [toKey, fromKey];
      const edgeKey = `${ordered[0]}\u0000${ordered[1]}`;
      const strength = Math.max(1, Math.min(100, Number(connection.strength) || 1));
      const evidence = Math.max(0, Number(connection.evidence) || Number(connection.weight) || strength);
      const decay = Math.max(0, Number(connection.decay) || 0);
      const score = Math.max(0, evidence - decay);
      const prev = edgeMap.get(edgeKey) || {
        fromKey: ordered[0],
        toKey: ordered[1],
        score: 0,
        evidence: 0,
        decay: 0,
        maxStrength: 0,
      };
      prev.score += score;
      prev.evidence += evidence;
      prev.decay += decay;
      prev.maxStrength = Math.max(prev.maxStrength, strength);
      edgeMap.set(edgeKey, prev);
    }
  }

  const maxTermScore = Math.max(1, ...[...termMap.values()].map((term) => term.score));
  const terms = [...termMap.values()]
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
    .slice(0, 2600)
    .map((term, index) => ({
      text: term.text,
      count: term.mentions,
      weight: Math.max(6, Math.min(100, Math.round((term.score / maxTermScore) * 100))),
      rank: index + 1,
      sources: [...term.sources],
    }));

  const termKeys = new Set(terms.map((term) => normalizeBrainDisplayKey(term.text)));
  const displayByKey = new Map(terms.map((term) => [normalizeBrainDisplayKey(term.text), term.text]));
  const positiveEdges = [...edgeMap.values()].filter((edge) => edge.score > 0 && termKeys.has(edge.fromKey) && termKeys.has(edge.toKey));
  const maxEdgeScore = Math.max(1, ...positiveEdges.map((edge) => edge.score));
  const connections = positiveEdges
    .sort((a, b) => b.score - a.score)
    .slice(0, 3000)
    .map((edge) => ({
      from: displayByKey.get(edge.fromKey),
      to: displayByKey.get(edge.toKey),
      strength: Math.max(8, Math.min(100, Math.round((edge.score / maxEdgeScore) * 100))),
      weight: Number(edge.score.toFixed(3)),
      evidence: Number(edge.evidence.toFixed(3)),
      decay: Number(edge.decay.toFixed(3)),
    }));

  if (onProgress) {
    onProgress({
      phase: 'complete',
      doneChunks: chunks.length,
      totalChunks: chunks.length,
      doneFiles: fileChunkTotals.size,
      totalFiles: fileChunkTotals.size,
      remainingFiles: 0,
      cacheHits: stats.cacheHits,
      generated: stats.generated,
      failed: stats.failed,
    });
  }

  brainDebugLog('raw_build_complete', {
    chunks: stats.chunks,
    cacheHits: stats.cacheHits,
    generated: stats.generated,
    empty: stats.empty,
    failed: stats.failed,
    terms: terms.length,
    connections: connections.length,
  });

  return { terms, connections, llmStats: stats };
}

app.get('/api/brain/cloud', async (req, res) => {
  try {
    const hard = req.query.hard === '1' || req.query.hard === 'true';
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true' || hard;
    const cacheOnly = req.query.cacheOnly === '1' || req.query.cacheOnly === 'true';
    const progressId = normalizeBrainProgressId(req.query.progressId);
    brainDebugLog('cloud_request', {
      refresh,
      hard,
      cacheOnly,
      progressId,
    });

    if (cacheOnly && !refresh) {
      const fallback = readLatestCompatibleBrainResponseCache();
      const fallbackPayload = brainFallbackPayloadForResponse(fallback);
      if (fallbackPayload) {
        brainDebugLog('cloud_cache_only_hit', {
          terms: Array.isArray(fallbackPayload?.terms) ? fallbackPayload.terms.length : 0,
          connections: Array.isArray(fallbackPayload?.connections) ? fallbackPayload.connections.length : 0,
        });
        res.set('Cache-Control', 'no-store');
        res.json({ ...fallbackPayload, cached: true, cacheOnly: true });
        return;
      }
      const activeProgress = getActiveBrainBuildProgress();
      if (activeProgress) {
        brainDebugLog('cloud_cache_only_in_progress', {
          progressId: activeProgress.id,
          phase: activeProgress.phase,
          doneChunks: activeProgress.doneChunks || 0,
          totalChunks: activeProgress.totalChunks || 0,
        });
        res.set('Cache-Control', 'no-store');
        res.status(409).json({
          error: 'Brain graph generation is already running.',
          inProgress: true,
          progressId: activeProgress.id,
          progress: activeProgress,
        });
        return;
      }
      brainDebugLog('cloud_cache_only_miss', {});
      res.status(404).json({ error: 'Brain graph has not been generated yet.', needsGenerate: true });
      return;
    }

    setBrainBuildProgress(progressId, { phase: 'collecting', done: false });
    const collectStartedAt = Date.now();
    brainDebugLog('cloud_collect_start', {
      refresh,
      hard,
      progressId,
    });
    const { corpus, stats } = collectBrainCorpus();
    brainDebugLog('cloud_collect_complete', {
      refresh,
      hard,
      progressId,
      ms: Date.now() - collectStartedAt,
      corpusItems: corpus.length,
      chars: stats.chars,
      memoryFiles: stats.memoryFiles,
      noteFiles: stats.noteFiles,
      importFiles: stats.importFiles,
      historyDays: stats.historyDays,
      exchanges: stats.exchanges,
    });
    const splitStartedAt = Date.now();
    brainDebugLog('cloud_split_start', {
      refresh,
      hard,
      progressId,
      corpusItems: corpus.length,
      chars: stats.chars,
    });
    const chunks = splitBrainCorpusForLlm(corpus);
    brainDebugLog('cloud_split_complete', {
      refresh,
      hard,
      progressId,
      ms: Date.now() - splitStartedAt,
      chunks: chunks.length,
      chunkChars: BRAIN_LLM_CHUNK_CHARS,
      overlapChars: BRAIN_LLM_CHUNK_OVERLAP_CHARS,
    });
    const totalFiles = new Set((chunks || []).map((chunk) => `${chunk.source || ''}:${chunk.label || ''}`)).size;
    setBrainBuildProgress(progressId, {
      phase: chunks.length ? 'processing' : 'complete',
      done: false,
      doneChunks: 0,
      totalChunks: chunks.length,
      doneFiles: 0,
      totalFiles,
      remainingFiles: totalFiles,
      cacheHits: 0,
      generated: 0,
      failed: 0,
    });
    const responseCacheKey = brainResponseCacheKey({ chunks });
    if (refresh) {
      brainCloudCache.delete(responseCacheKey);
    }
    const cachedMemory = refresh ? null : brainCloudCache.get(responseCacheKey)?.payload;
    const cachedDisk = refresh || cachedMemory ? null : readBrainResponseCache(responseCacheKey);
    const cachedPayload = cachedMemory || cachedDisk;
    if (!refresh && brainPayloadIsReusable(cachedPayload)) {
      brainCloudCache.set(responseCacheKey, { cachedAtMs: Date.now(), payload: cachedPayload });
      brainDebugLog('cloud_response_cache_hit', {
        cache: cachedMemory ? 'memory' : 'disk',
        terms: Array.isArray(cachedPayload?.terms) ? cachedPayload.terms.length : 0,
        connections: Array.isArray(cachedPayload?.connections) ? cachedPayload.connections.length : 0,
      });
      finishBrainBuildProgress(progressId, {
        phase: 'complete',
        doneChunks: chunks.length,
        totalChunks: chunks.length,
        doneFiles: 0,
        totalFiles: 0,
        remainingFiles: 0,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ ...cachedPayload, cached: true });
      return;
    }
    if (!corpus.length) {
      const payload = {
        updatedAtMs: Date.now(),
        terms: [],
        connections: [],
        denseTerms: [],
        denseConnections: [],
        stats: {
          ...stats,
          rawTerms: 0,
          rawConnections: 0,
          finalTerms: 0,
          finalConnections: 0,
        },
      };
      brainCloudCache.set(responseCacheKey, { cachedAtMs: Date.now(), payload });
      writeBrainResponseCache(responseCacheKey, payload);
      brainDebugLog('cloud_response_empty_corpus', {});
      finishBrainBuildProgress(progressId, {
        phase: 'complete',
        doneChunks: 0,
        totalChunks: 0,
        doneFiles: 0,
        totalFiles: 0,
        remainingFiles: 0,
      });
      res.set('Cache-Control', 'no-store');
      res.json({ ...payload, cached: false });
      return;
    }

    let denseBuild = brainCloudBuilds.get(responseCacheKey);
    if (denseBuild) {
      brainDebugLog('raw_build_shared', {
        force: hard,
        chunks: chunks.length,
      });
    } else {
      denseBuild = buildLlmBrainGraph(corpus, {
        force: hard,
        chunks,
        onProgress: (progress) => setBrainBuildProgress(progressId, {
          ...progress,
          done: false,
        }),
      }).finally(() => {
        if (brainCloudBuilds.get(responseCacheKey) === denseBuild) {
          brainCloudBuilds.delete(responseCacheKey);
        }
      });
      brainCloudBuilds.set(responseCacheKey, denseBuild);
    }
    const dense = await denseBuild;
    const responseStillOpen = !(req.aborted || req.destroyed || res.destroyed);
    const denseHasTerms = Array.isArray(dense?.terms) && dense.terms.length > 0;
    if (!refresh && !denseHasTerms) {
      const fallback = readLatestCompatibleBrainResponseCache();
      const fallbackPayload = brainFallbackPayloadForResponse(fallback);
      if (fallbackPayload) {
        brainCloudCache.set(responseCacheKey, { cachedAtMs: Date.now(), payload: fallbackPayload });
        brainDebugLog('cloud_response_fallback', {
          reason: 'raw_build_empty',
          terms: Array.isArray(fallbackPayload?.terms) ? fallbackPayload.terms.length : 0,
          connections: Array.isArray(fallbackPayload?.connections) ? fallbackPayload.connections.length : 0,
        });
        finishBrainBuildProgress(progressId, {
          phase: 'complete',
          doneChunks: dense.llmStats?.chunks || 0,
          totalChunks: dense.llmStats?.chunks || 0,
          remainingFiles: 0,
          cacheHits: dense.llmStats?.cacheHits || 0,
          generated: dense.llmStats?.generated || 0,
          failed: dense.llmStats?.failed || 0,
        });
        if (!responseStillOpen) {
          brainDebugLog('cloud_response_skipped', { reason: 'client_closed_after_fallback' });
          return;
        }
        res.set('Cache-Control', 'no-store');
        res.json({ ...fallbackPayload, cached: true, stale: true, staleReason: 'raw_build_empty' });
        return;
      }
    }
    const payload = {
      updatedAtMs: Date.now(),
      terms: dense.terms || [],
      connections: dense.connections || [],
      denseTerms: dense.terms || [],
      denseConnections: dense.connections || [],
      stats: {
        ...stats,
        llmChunks: dense.llmStats?.chunks || 0,
        llmCacheHits: dense.llmStats?.cacheHits || 0,
        llmGenerated: dense.llmStats?.generated || 0,
        llmEmpty: dense.llmStats?.empty || 0,
        llmFailed: dense.llmStats?.failed || 0,
        rawTerms: Array.isArray(dense.terms) ? dense.terms.length : 0,
        rawConnections: Array.isArray(dense.connections) ? dense.connections.length : 0,
        finalTerms: Array.isArray(dense.terms) ? dense.terms.length : 0,
        finalConnections: Array.isArray(dense.connections) ? dense.connections.length : 0,
      },
    };
    brainCloudCache.set(responseCacheKey, { cachedAtMs: Date.now(), payload });
    writeBrainResponseCache(responseCacheKey, payload);
    brainDebugLog('cloud_response_complete', {
      rawTerms: payload.stats.rawTerms,
      rawConnections: payload.stats.rawConnections,
      finalTerms: payload.stats.finalTerms,
      finalConnections: payload.stats.finalConnections,
      llmChunks: payload.stats.llmChunks,
      llmCacheHits: payload.stats.llmCacheHits,
      llmGenerated: payload.stats.llmGenerated,
      llmEmpty: payload.stats.llmEmpty,
      llmFailed: payload.stats.llmFailed,
    });
    finishBrainBuildProgress(progressId, {
      phase: 'complete',
      doneChunks: dense.llmStats?.chunks || 0,
      totalChunks: dense.llmStats?.chunks || 0,
      remainingFiles: 0,
      cacheHits: dense.llmStats?.cacheHits || 0,
      generated: dense.llmStats?.generated || 0,
      failed: dense.llmStats?.failed || 0,
    });
    if (!responseStillOpen) {
      brainDebugLog('cloud_response_skipped', {
        reason: 'client_closed_after_cache_write',
        terms: payload.stats.finalTerms,
        connections: payload.stats.finalConnections,
      });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ...payload, cached: false });
  } catch (err) {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true' || req.query.hard === '1';
    const progressId = normalizeBrainProgressId(req.query.progressId);
    brainDebugLog('cloud_error', {
      refresh,
      progressId,
      error: err.message,
      stack: String(err?.stack || '').slice(0, 4000),
    });
    if (!refresh) {
      const fallback = readLatestCompatibleBrainResponseCache();
      const fallbackPayload = brainFallbackPayloadForResponse(fallback);
      if (fallbackPayload) {
        brainDebugLog('cloud_response_fallback', {
          reason: 'error',
          error: err.message,
          terms: Array.isArray(fallbackPayload?.terms) ? fallbackPayload.terms.length : 0,
          connections: Array.isArray(fallbackPayload?.connections) ? fallbackPayload.connections.length : 0,
        });
        finishBrainBuildProgress(progressId, {
          phase: 'complete',
          error: err.message,
        });
        res.set('Cache-Control', 'no-store');
        res.json({ ...fallbackPayload, cached: true, stale: true, staleReason: 'error' });
        return;
      }
    }
    finishBrainBuildProgress(progressId, {
      phase: 'error',
      error: err.message,
    });
    if (req.aborted || req.destroyed || res.destroyed) {
      brainDebugLog('cloud_error_response_skipped', { reason: 'client_closed' });
      return;
    }
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brain/progress', (req, res) => {
  const id = normalizeBrainProgressId(req.query.id);
  const progress = id ? brainBuildProgress.get(id) : null;
  res.set('Cache-Control', 'no-store');
  res.json(progress || { phase: 'idle', done: true });
});

function importBrainPayload(payload) {
  let provider = payload.provider;
  const requestedProvider = provider;
  const originalName = payload.filename;
  const workspaceDir = getWorkspaceDir();
  let text = null;

  if (payload.rawKind === 'zip' && provider === 'other') {
    text = buildBrainImportTextFromPayload(payload);
    if (payload.detectedProvider && BRAIN_IMPORT_PROVIDERS.has(payload.detectedProvider)) {
      provider = payload.detectedProvider;
    }
  }

  let safeProvider = safeBrainPathPart(provider);
  let importId = brainImportPayloadSignature(provider, payload.contentHash);
  const importsRoot = brainImportsDir(workspaceDir);
  let importRoot = join(importsRoot, safeProvider, importId);
  const requestedImportRoot = join(importsRoot, safeBrainPathPart(requestedProvider), brainImportPayloadSignature(requestedProvider, payload.contentHash));
  let existingManifest = readValidBrainImportManifest(importRoot);
  if (existingManifest) {
    const files = Array.isArray(existingManifest.files) ? existingManifest.files : [];
    if (requestedImportRoot !== importRoot) {
      markBrainImportSuperseded(requestedImportRoot, `brain-imports/${safeProvider}/${importId}`);
    }
    brainDebugLog('import_reused', { provider, importId, files: files.length });
    return {
      ok: true,
      reused: true,
      importId,
      provider,
      providerLabel: brainImportProviderLabel(provider),
      path: `brain-imports/${safeProvider}/${importId}`,
      conversations: Number(existingManifest.conversations) || files.length,
      messages: Number(existingManifest.messages) || 0,
      files: files.length,
      chars: Number(existingManifest.extractedChars) || 0,
    };
  }

  brainDebugLog('import_extract_start', {
    provider,
    requestedProvider,
    importId,
    rawKind: payload.rawKind,
    filename: originalName || '',
    bytes: payload.rawBytes != null ? payload.rawBytes : payload.rawBuffer ? payload.rawBuffer.length : 0,
  });
  let conversations;
  try {
    text = text || buildBrainImportTextFromPayload(payload);
    if (payload.detectedProvider && BRAIN_IMPORT_PROVIDERS.has(payload.detectedProvider) && payload.detectedProvider !== provider) {
      provider = payload.detectedProvider;
      safeProvider = safeBrainPathPart(provider);
      importId = brainImportPayloadSignature(provider, payload.contentHash);
      importRoot = join(importsRoot, safeProvider, importId);
      existingManifest = readValidBrainImportManifest(importRoot);
      brainDebugLog('import_provider_detected', {
        requestedProvider,
        provider,
        importId,
        filename: originalName || '',
      });
      if (existingManifest) {
        const files = Array.isArray(existingManifest.files) ? existingManifest.files : [];
        if (requestedImportRoot !== importRoot) {
          markBrainImportSuperseded(requestedImportRoot, `brain-imports/${safeProvider}/${importId}`);
        }
        brainDebugLog('import_reused_detected_provider', { provider, importId, files: files.length });
        return {
          ok: true,
          reused: true,
          importId,
          provider,
          providerLabel: brainImportProviderLabel(provider),
          path: `brain-imports/${safeProvider}/${importId}`,
          conversations: Number(existingManifest.conversations) || files.length,
          messages: Number(existingManifest.messages) || 0,
          files: files.length,
          chars: Number(existingManifest.extractedChars) || 0,
        };
      }
    }
    conversations = extractBrainImportConversations(provider, text);
  } catch (err) {
    brainDebugLog('import_extract_failed', {
      provider,
      importId,
      filename: originalName || '',
      stage: 'read_payload',
      error: err.message,
    });
    throw err;
  }
  if (!conversations.length) {
    brainDebugLog('import_extract_failed', {
      provider,
      importId,
      filename: originalName || '',
      stage: 'conversation_extract',
      error: 'No conversations were found in that import.',
    });
    const err = new Error('No conversations were found in that import.');
    err.statusCode = 400;
    throw err;
  }

  const stagingParent = join(importsRoot, '.staging');
  if (!existsSync(stagingParent)) mkdirSync(stagingParent, { recursive: true });
  const stagingRoot = mkdtempSync(join(stagingParent, `${safeProvider}-${importId}-`));
  const rawDir = join(stagingRoot, 'raw');
  const conversationsDir = join(stagingRoot, 'conversations');
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
  if (!existsSync(conversationsDir)) mkdirSync(conversationsDir, { recursive: true });

  try {
    const rawBase = safeBrainPathPart(originalName || `${provider}-export`, 'export');
    const rawName = payload.rawKind === 'zip' ? `${rawBase}.zip` : `${rawBase}.raw.txt`;
    if (payload.rawPath) copyFileSync(payload.rawPath, join(rawDir, rawName));
    else writeFileSync(join(rawDir, rawName), payload.rawBuffer);

    let extractedChars = 0;
    const files = [];
    conversations.forEach((conversation, index) => {
      const titlePart = safeBrainPathPart(conversation.title, `conversation-${index + 1}`);
      const fileName = `${String(index + 1).padStart(4, '0')}-${titlePart}.md`;
      const markdown = renderBrainConversationMarkdown({ provider, originalName, conversation, index, importId });
      writeFileSync(join(conversationsDir, fileName), markdown, 'utf8');
      extractedChars += markdown.length;
      files.push(`conversations/${fileName}`);
    });

    const messages = conversations.reduce((sum, conv) => sum + conv.messages.length, 0);
    const manifest = {
      importId,
      provider,
      providerLabel: brainImportProviderLabel(provider),
      originalName,
      contentHash: payload.contentHash,
      rawKind: payload.rawKind,
      importedAt: new Date().toISOString(),
      raw: `raw/${rawName}`,
      status: 'extracted',
      conversations: conversations.length,
      messages,
      extractedChars,
      files,
    };
    writeFileSync(join(stagingRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const stagedManifest = readValidBrainImportManifest(stagingRoot);
    if (!stagedManifest) {
      const err = new Error('Import extraction did not produce a complete brain manifest.');
      err.statusCode = 500;
      throw err;
    }

    const latestExistingManifest = readValidBrainImportManifest(importRoot);
    if (latestExistingManifest) {
      rmSync(stagingRoot, { recursive: true, force: true });
      const existingFiles = Array.isArray(latestExistingManifest.files) ? latestExistingManifest.files : [];
      brainDebugLog('import_reused_after_extract', { provider, importId, files: existingFiles.length });
      return {
        ok: true,
        reused: true,
        importId,
        provider,
        providerLabel: brainImportProviderLabel(provider),
        path: `brain-imports/${safeProvider}/${importId}`,
        conversations: Number(latestExistingManifest.conversations) || existingFiles.length,
        messages: Number(latestExistingManifest.messages) || 0,
        files: existingFiles.length,
        chars: Number(latestExistingManifest.extractedChars) || 0,
      };
    }
    if (existsSync(importRoot)) {
      brainDebugLog('import_replace_incomplete', { provider, importId });
      rmSync(importRoot, { recursive: true, force: true });
    }
    mkdirSync(dirname(importRoot), { recursive: true });
    renameSync(stagingRoot, importRoot);
    if (requestedImportRoot !== importRoot) {
      markBrainImportSuperseded(requestedImportRoot, `brain-imports/${safeProvider}/${importId}`);
    }
    brainCloudCache.clear();
    brainDebugLog('import_extract_complete', {
      provider,
      importId,
      conversations: conversations.length,
      messages,
      files: files.length,
      chars: extractedChars,
    });

    return {
      ok: true,
      importId,
      provider,
      providerLabel: brainImportProviderLabel(provider),
      path: `brain-imports/${safeProvider}/${importId}`,
      conversations: conversations.length,
      messages,
      files: files.length,
      chars: extractedChars,
    };
  } catch (err) {
    try {
      rmSync(stagingRoot, { recursive: true, force: true });
    } catch (_) {}
    brainDebugLog('import_extract_failed', {
      provider,
      importId,
      filename: originalName || '',
      error: err.message,
    });
    throw err;
  }
}

function saveBrainImportRequestToFile(req, destPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const out = createWriteStream(destPath);
    let settled = false;

    function finish(err) {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ bytes, contentHash: hash.digest('hex') });
    }

    req.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    req.on('error', finish);
    out.on('error', finish);
    out.on('finish', () => finish());
    req.pipe(out);
  });
}

app.post('/api/brain/import-chat-file', async (req, res) => {
  let tmpDir = null;
  try {
    const filename = String(req.query.filename || '').trim().slice(0, 180);
    const provider = normalizeBrainImportProvider(req.query.provider);
    const contentType = String(req.query.contentType || '');
    const rawKind = isBrainZipFileName(filename) || contentType.toLowerCase().includes('zip') ? 'zip' : 'binary';
    const tmpRoot = join(getStateDir(), 'tmp');
    if (!existsSync(tmpRoot)) mkdirSync(tmpRoot, { recursive: true });
    tmpDir = mkdtempSync(join(tmpRoot, 'brain-upload-'));
    const uploadPath = join(tmpDir, rawKind === 'zip' ? 'upload.zip' : 'upload.raw');
    const saved = await saveBrainImportRequestToFile(req, uploadPath);
    if (!saved.bytes) {
      res.status(400).json({ error: 'Choose an export file or paste a transcript first.' });
      return;
    }
    if (saved.bytes > maxBrainImportInputBytes(rawKind)) {
      res.status(413).json({ error: 'Import is too large for the dashboard. Try a smaller export file.' });
      return;
    }
    res.json(importBrainPayload({
      provider,
      filename,
      rawPath: uploadPath,
      rawBytes: saved.bytes,
      rawKind,
      contentHash: saved.contentHash,
    }));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  } finally {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
});

app.post('/api/brain/import-chat', (req, res) => {
  try {
    res.json(importBrainPayload(decodeBrainImportPayload(req.body || {})));
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---- Agent identity files ----

const AGENT_FILE_IDS = ['SOUL.md', 'WhoAmI.md', 'MyHuman.md', 'group.md', 'MEMORY.md'];
const AGENT_FILE_LABELS = {
  'SOUL.md': 'Soul',
  'WhoAmI.md': 'Who am I',
  'MyHuman.md': 'My human',
  'group.md': 'Group rules',
  'MEMORY.md': 'Memory',
};

function getAgentMdPath(agentId, key) {
  return join(getAgentWorkspaceDir(agentId), key);
}

app.get('/api/agents/:id/md', (req, res) => {
  try {
    const agentId = req.params.id || DEFAULT_AGENT_ID;
    if (rejectInternalAgent(agentId, res)) return;
    loadAgentConfig(agentId);
    const files = AGENT_FILE_IDS.map((id) => {
      const p = getAgentMdPath(agentId, id);
      return { id, label: AGENT_FILE_LABELS[id] || id, exists: existsSync(p) };
    });
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/md/:key', (req, res) => {
  try {
    const agentId = req.params.id || DEFAULT_AGENT_ID;
    if (rejectInternalAgent(agentId, res)) return;
    loadAgentConfig(agentId);
    const key = req.params.key;
    if (!AGENT_FILE_IDS.includes(key)) {
      res.status(400).json({ error: 'Invalid file key' });
      return;
    }
    const path = getAgentMdPath(agentId, key);
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    res.json({ id: key, label: AGENT_FILE_LABELS[key] || key, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/agents/:id/md/:key', (req, res) => {
  try {
    const agentId = req.params.id || DEFAULT_AGENT_ID;
    if (rejectInternalAgent(agentId, res)) return;
    loadAgentConfig(agentId);
    const key = req.params.key;
    if (!AGENT_FILE_IDS.includes(key)) {
      res.status(400).json({ error: 'Invalid file key' });
      return;
    }
    const path = getAgentMdPath(agentId, key);
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, 'utf8');
    res.json({ id: key, ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Per-group identity files are deprecated (agent-scoped now) ----

app.get('/api/groups/:id/md', (req, res) => {
  res.status(410).json({ error: 'Per-group identity files are removed. Use /api/agents/:id/config and agent workspace files.' });
});

app.get('/api/groups/:id/md/:key', (req, res) => {
  res.status(410).json({ error: 'Per-group identity files are removed. Use agent identity files instead.' });
});

app.patch('/api/groups/:id/md/:key', (req, res) => {
  res.status(410).json({ error: 'Per-group identity files are removed. Use agent identity files instead.' });
});

// ── Projects API ──────────────────────────────────────────────────────────────

app.get('/api/projects', (_req, res) => {
  try { res.json(listProjects()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', (req, res) => {
  const { name, description, url, setup_notes, team_id, teamId } = req.body || {};
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const hasTeam = team_id !== undefined || teamId !== undefined;
    const projectTeamId = hasTeam ? normalizeProjectTeamId(team_id || teamId || '') : '';
    if (projectTeamId) ensureTeam(projectTeamId);
    res.status(201).json(createProject({
      name: String(name).trim(),
      description: String(description || '').trim(),
      url: String(url || '').trim(),
      setup_notes: String(setup_notes || '').trim(),
      team_id: projectTeamId,
    }));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/:id', (req, res) => {
  const { name, description, url, setup_notes, connectors, team_id, teamId } = req.body || {};
  const id = Number(req.params.id);
  const existing = getProject(id);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const nextName = name !== undefined ? String(name || '').trim() : existing.name;
  if (!nextName) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const nextTeamId = team_id !== undefined || teamId !== undefined
      ? normalizeProjectTeamId(team_id || teamId || '')
      : undefined;
    if (nextTeamId) ensureTeam(nextTeamId);
    const p = updateProject(id, {
      name: nextName,
      description: description !== undefined ? String(description || '').trim() : existing.description,
      url: url !== undefined ? String(url || '').trim() : undefined,
      setup_notes: setup_notes !== undefined ? String(setup_notes || '').trim() : undefined,
      connectors: connectors !== undefined && typeof connectors === 'object' ? connectors : undefined,
      team_id: nextTeamId,
    });
    if (!p) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/llm/usage', (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    let count = 0;
    try {
      const raw = readFileSync(getLlmUsagePath(), 'utf8');
      const data = JSON.parse(raw);
      if (data && data.date === today) count = Number(data.count) || 0;
    } catch (_) {}
    const config = (() => {
      try { return JSON.parse(readFileSync(getConfigPath(), 'utf8')); } catch (_) { return {}; }
    })();
    const limit = Number(config?.llm?.dailyLimit) || 100;
    const localRpm = config?.llm?.localRpm !== undefined ? Number(config.llm.localRpm) : 1;
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    res.json({ date: today, count, limit, localRpm, msUntilReset: midnight.getTime() - Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/llm/usage/reset', (_req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const payload = JSON.stringify({ date: today, count: 0 });
    const dest = getLlmUsagePath();
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, payload, 'utf8');
    res.json({ ok: true, date: today, count: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/llm/local-rpm', (req, res) => {
  try {
    const rpm = Number(req.body?.localRpm);
    if (isNaN(rpm) || rpm < 0) {
      res.status(400).json({ error: 'localRpm must be a non-negative number (0 = unlimited)' });
      return;
    }
    const config = (() => {
      try { return JSON.parse(readFileSync(getConfigPath(), 'utf8')); } catch (_) { return {}; }
    })();
    config.llm = { ...(config.llm || {}), localRpm: rpm };
    saveConfig(config);
    res.json({ ok: true, localRpm: rpm });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/connectors/status', (_req, res) => {
  try {
    const config = loadConfig();
    res.json({
      github: {
        status: getSkillConfigStatus('github'),
        defaultRepo: String(config?.skills?.github?.defaultRepo || '').trim(),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
  try { deleteProject(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Project workflow pending approvals (Mission Control UI) ───────────────────

app.get('/api/project-workflow/pending', (_req, res) => {
  try {
    res.json(listPendingProposals());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/project-workflow/pending/:id/approve', async (req, res) => {
  try {
    const result = await approvePendingProposal(req.params.id);
    if (!result.ok) {
      res.status(result.needsApproval ? 409 : 400).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/project-workflow/pending/:id/reject', (req, res) => {
  try {
    const result = rejectPendingProposal(req.params.id);
    if (!result.ok) {
      res.status(404).json(result);
      return;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/projects/:id/graph', (req, res) => {
  try {
    const g = getProjectGraph(Number(req.params.id));
    if (!g) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(g);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/updates', (req, res) => {
  const { branch_id, parent_update_id, text } = req.body || {};
  if (!text || !String(text).trim()) { res.status(400).json({ error: 'text required' }); return; }
  try {
    res.status(201).json(createUpdate({
      project_id: Number(req.params.id),
      branch_id: branch_id != null ? Number(branch_id) : null,
      parent_update_id: parent_update_id != null ? Number(parent_update_id) : null,
      text: String(text).trim(),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/updates/:id', (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) { res.status(400).json({ error: 'text required' }); return; }
  try { res.json(editUpdate(Number(req.params.id), { text: String(text).trim() })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/updates/:id', (req, res) => {
  try { deleteUpdate(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:id/branches', (req, res) => {
  const { parent_update_id, name } = req.body || {};
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    res.status(201).json(createBranch({
      project_id: Number(req.params.id),
      parent_update_id: parent_update_id != null ? Number(parent_update_id) : null,
      name: String(name).trim(),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/branches/:id', (req, res) => {
  try { deleteBranch(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Static files
app.use(express.static(join(__dirname, 'public')));

// SPA fallback — serve index.html for every non-API path so /team/tasks works on reload
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

async function releasePort(port) {
  try {
    let pids = [];
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      const suffix = `:${port}`;
      const seen = new Set();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue;
        if (!parts[1].endsWith(suffix)) continue;
        const pid = parts[4];
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          pids.push(pid);
        }
      }
    } else {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' });
      pids = out.trim().split(/\s+/).filter(Boolean);
    }
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch (_) {}
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 400));
  } catch (_) {}
}

await releasePort(PORT);
const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Pasture Protocol Dashboard');
  console.log('  ─────────────────');
  console.log(`  URL: http://${HOST}:${PORT}`);
  console.log('  (Use this URL to POST data for future features.)');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Set PASTURE_DASHBOARD_PORT to another port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
