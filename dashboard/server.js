#!/usr/bin/env node
/**
 * Pasture Protocol dashboard: web UI for status, crons, skills, LLM config.
 * Run: pasture dashboard  (or pnpm run dashboard from repo)
 * Serves on port 3847 by default (PASTURE_DASHBOARD_PORT).
 */

import dotenv from 'dotenv';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
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

// Use same state dir as main app (e.g. PASTURE_STATE_DIR from ~/.pasture/.env)
dotenv.config({ path: getEnvPath() });
import { getResolvedTimezone, getResolvedTimeFormat } from '../lib/util/timezone.js';
import { loadStore } from '../cron/store.js';
import { DEFAULT_ENABLED, UI_HIDDEN_SKILL_IDS, stripImplicitSkillsFromConfig } from '../skills/loader.js';
import { getGroupRestrictions, saveGroupRestrictions } from '../lib/channels/group-config.js';
import { ensureMainAgentInitialized, loadAgentConfig, saveAgentConfig, listVisibleAgentIds, isInternalAgent, DEFAULT_AGENT_ID, resolveAgentIdForGroup, createAgent, deleteAgent, getAgentMessagingPolicy, getAgentTitle, normalizeAgentTitle, normalizeAgentMessagingPolicy, syncAgentSendSkillInConfig, appendAgentTitleAlias } from '../lib/agent/agent-config.js';
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
const PORT = Number(process.env.PASTURE_DASHBOARD_PORT) || 3847;
const HOST = process.env.PASTURE_DASHBOARD_HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '25mb' }));
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
    const created = createAgent(rawId, opts);
    let config = loadAgentConfig(created.id);
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
// Discover tests automatically: any scripts/test/<dir>/ with inputs.md and a matching test-<dir>-e2e.js or test-<dir>.js

const TEST_RUN_TIMEOUT_MS = 180_000; // 3 min per test

/** Where test scripts run from (install dir, or repo override for dev). */
function getTestRoot() {
  if (process.env.PASTURE_TEST_ROOT) {
    return resolve(process.env.PASTURE_TEST_ROOT);
  }
  const installMarker = join(INSTALL_DIR, 'scripts', 'test', 'e2e-report.js');
  if (existsSync(installMarker)) return INSTALL_DIR;
  const repoMarker = join(ROOT, 'scripts', 'test', 'e2e-report.js');
  if (ROOT !== INSTALL_DIR && existsSync(repoMarker)) return ROOT;
  return INSTALL_DIR;
}

function getTestList() {
  const testDir = join(getTestRoot(), 'scripts', 'test');
  if (!existsSync(testDir)) return [];
  const dirs = readdirSync(testDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const list = [];
  for (const id of dirs) {
    const inputsPath = join(testDir, id, 'inputs.md');
    if (!existsSync(inputsPath)) continue;
    const scriptE2e = join(testDir, 'test-' + id + '-e2e.js');
    const scriptPlain = join(testDir, 'test-' + id + '.js');
    const scriptPath = existsSync(scriptE2e) ? scriptE2e : (existsSync(scriptPlain) ? scriptPlain : null);
    if (!scriptPath) continue;
    const script = 'scripts/test/' + (existsSync(scriptE2e) ? 'test-' + id + '-e2e.js' : 'test-' + id + '.js');
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

const BRAIN_CACHE_MS = 5 * 60 * 1000;
const BRAIN_CORPUS_MAX_CHARS = 32_000;
const BRAIN_DENSE_CORPUS_MAX_CHARS = 1_200_000;
const BRAIN_LLM_CHUNK_CHARS = 9_000;
const BRAIN_LLM_MAX_CHUNKS = 160;
const BRAIN_LLM_CACHE_VERSION = 1;
const BRAIN_IMPORT_MAX_INPUT_CHARS = 20 * 1024 * 1024;
const BRAIN_IMPORT_PROVIDERS = new Set(['chatgpt', 'grok', 'claude', 'gemini', 'perplexity', 'copilot', 'other']);
const brainCloudCache = new Map();
const brainBuildProgress = new Map();

function brainHashText(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
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

function brainLlmCacheDir() {
  return join(getStateDir(), 'brain-llm-cache', `v${BRAIN_LLM_CACHE_VERSION}`);
}

function brainLlmChunkCachePath(key) {
  return join(brainLlmCacheDir(), key.slice(0, 2), `${key}.json`);
}

function readBrainLlmChunkCache(key) {
  const path = brainLlmChunkCachePath(key);
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed?.terms) || !Array.isArray(parsed?.connections)) return null;
    return parsed;
  } catch (_) {
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

function normalizeBrainRange(value) {
  const v = String(value || 'all').trim();
  return v === '7d' || v === '30d' || v === 'all' ? v : 'all';
}

function normalizeBrainSource(value) {
  const v = String(value || 'all').trim();
  return v === 'memory' || v === 'notes' || v === 'history' || v === 'all' ? v : 'all';
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

function brainImportId(provider, text) {
  return brainHashText(`${provider}\n${text}`).slice(0, 24);
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
        if (conv?.mapping) return extractChatGptConversation(conv, index);
        return extractGenericConversation(conv, index);
      }).filter((conv) => conv.messages.length > 0);
      if (conversations.length) return conversations;
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

function brainRangeCutoffMs(range) {
  if (range === '7d') return Date.now() - 7 * 86400000;
  if (range === '30d') return Date.now() - 30 * 86400000;
  return 0;
}

function pushBrainCorpusChunk(out, chunk, remaining) {
  if (!chunk || remaining.value <= 0) return;
  const text = String(chunk.text || '').trim();
  if (!text) return;
  const sliced = text.length > remaining.value ? text.slice(0, remaining.value) : text;
  out.push({
    source: chunk.source,
    label: String(chunk.label || chunk.source || '').slice(0, 120),
    role: chunk.role ? String(chunk.role).slice(0, 40) : '',
    ts: Number(chunk.ts || 0) || 0,
    text: sliced,
  });
  remaining.value -= sliced.length;
}

function collectBrainCorpus({ range, source, maxChars = BRAIN_CORPUS_MAX_CHARS }) {
  const workspaceDir = getWorkspaceDir();
  const includeMemory = source === 'all' || source === 'memory';
  const includeNotes = source === 'all' || source === 'notes';
  const includeHistory = source === 'all' || source === 'history';
  const cutoffMs = brainRangeCutoffMs(range);
  const corpus = [];
  const remaining = { value: maxChars };
  const stats = { memoryFiles: 0, noteFiles: 0, importFiles: 0, historyDays: 0, exchanges: 0, chars: 0 };

  if (includeMemory) {
    for (const name of ['MEMORY.md', 'memory.md']) {
      const full = join(workspaceDir, name);
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          const text = readFileSync(full, 'utf8');
          stats.memoryFiles += 1;
          pushBrainCorpusChunk(corpus, { source: 'memory', label: name, text }, remaining);
        }
      } catch (_) {}
    }
  }

  if (includeNotes) {
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
          pushBrainCorpusChunk(corpus, { source: 'notes', label: `memory/${name}`, text }, remaining);
          if (remaining.value <= 0) break;
        }
      }
    } catch (_) {}

    const importsDir = brainImportsDir(workspaceDir);
    try {
      if (existsSync(importsDir) && statSync(importsDir).isDirectory()) {
        for (const providerName of readdirSync(importsDir).sort()) {
          const providerDir = join(importsDir, providerName);
          if (!statSync(providerDir).isDirectory()) continue;
          for (const importName of readdirSync(providerDir).sort()) {
            const conversationsDir = join(providerDir, importName, 'conversations');
            if (!existsSync(conversationsDir) || !statSync(conversationsDir).isDirectory()) continue;
            for (const name of readdirSync(conversationsDir).sort()) {
              if (!name.endsWith('.md')) continue;
              const full = join(conversationsDir, name);
              if (!statSync(full).isFile()) continue;
              const text = readFileSync(full, 'utf8');
              stats.importFiles += 1;
              pushBrainCorpusChunk(corpus, {
                source: 'notes',
                label: `brain-imports/${providerName}/${importName}/conversations/${name}`,
                text,
              }, remaining);
              if (remaining.value <= 0) break;
            }
            if (remaining.value <= 0) break;
          }
          if (remaining.value <= 0) break;
        }
      }
    } catch (_) {}
  }

  if (includeHistory && remaining.value > 0) {
    const days = collectChatLogDateEntries(workspaceDir)
      .filter((d) => !cutoffMs || Number(d.lastActivityMs || 0) >= cutoffMs);
    for (const day of days) {
      if (remaining.value <= 0) break;
      const exchanges = readChatLogDayExchanges(workspaceDir, day.date);
      if (!exchanges.length) continue;
      stats.historyDays += 1;
      stats.exchanges += exchanges.length;
      for (const ex of exchanges) {
        if (remaining.value <= 0) break;
        const text = String(ex?.user || '').trim();
        if (!text) continue;
        pushBrainCorpusChunk(corpus, {
          source: 'history',
          label: day.date,
          role: 'user',
          ts: ex.ts,
          text,
        }, remaining);
      }
    }
  }

  stats.chars = maxChars - remaining.value;
  return { corpus, stats };
}

function splitBrainCorpusForLlm(corpus) {
  const chunks = [];
  for (const item of corpus || []) {
    const text = String(item?.text || '').trim();
    if (!text) continue;
    for (let start = 0, index = 0; start < text.length; start += BRAIN_LLM_CHUNK_CHARS, index++) {
      const slice = text.slice(start, start + BRAIN_LLM_CHUNK_CHARS).trim();
      if (!slice) continue;
      chunks.push({
        source: item.source,
        label: item.label,
        role: item.role || '',
        ts: item.ts || 0,
        chunkIndex: index,
        text: slice,
      });
      if (chunks.length >= BRAIN_LLM_MAX_CHUNKS) return chunks;
    }
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

function normalizeBrainDisplayKey(text) {
  return String(text || '').trim().toLowerCase();
}

function mergeBrainSources(target, sources) {
  for (const source of sources || []) {
    const s = String(source || '').trim();
    if (s) target.add(s);
  }
}

async function buildLlmBrainGraph(corpus, { range, source, onProgress } = {}) {
  const chunks = splitBrainCorpusForLlm(corpus);
  const termMap = new Map();
  const edgeMap = new Map();
  const stats = { chunks: chunks.length, cacheHits: 0, generated: 0, failed: 0 };
  const fileChunkTotals = new Map();
  const fileChunkDone = new Map();
  let doneFiles = 0;

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
    let graph = readBrainLlmChunkCache(cacheKey);
    if (graph) {
      stats.cacheHits += 1;
      markBrainImportChunkProcessed(chunk.label, chunk.chunkIndex, cacheKey, 'cached');
    } else {
      graph = await generateBrainChunkGraph({ range, source, chunk });
      if (!graph) {
        stats.failed += 1;
        graph = { terms: [], connections: [] };
        markBrainImportChunkProcessed(chunk.label, chunk.chunkIndex, cacheKey, 'failed');
      } else {
        writeBrainLlmChunkCache(cacheKey, {
          source: chunk.source,
          label: chunk.label,
          role: chunk.role,
          chunkIndex: chunk.chunkIndex,
          textHash: brainHashText(chunk.text || ''),
          terms: graph.terms,
          connections: graph.connections,
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

  return { terms, connections, llmStats: stats };
}

app.get('/api/brain/cloud', async (req, res) => {
  try {
    const range = normalizeBrainRange(req.query.range);
    const source = normalizeBrainSource(req.query.source);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true' || req.query.hard === '1';
    const progressId = normalizeBrainProgressId(req.query.progressId);
    const cacheKey = `${range}:${source}`;
    if (refresh) brainCloudCache.delete(cacheKey);
    const cached = brainCloudCache.get(cacheKey);
    const cachedHasTerms = Array.isArray(cached?.payload?.terms) && cached.payload.terms.length > 0;
    const cachedHadNoCorpus = Number(cached?.payload?.stats?.chars || 0) === 0;
    if (!refresh && cached && (cachedHasTerms || cachedHadNoCorpus) && Date.now() - cached.cachedAtMs < BRAIN_CACHE_MS) {
      res.set('Cache-Control', 'no-store');
      res.json({ ...cached.payload, cached: true });
      return;
    }

    setBrainBuildProgress(progressId, { phase: 'collecting', done: false });
    const { corpus, stats } = collectBrainCorpus({ range, source, maxChars: BRAIN_DENSE_CORPUS_MAX_CHARS });
    if (!corpus.length) {
      const payload = {
        range,
        source,
        updatedAtMs: Date.now(),
        terms: [],
        stats,
      };
      brainCloudCache.set(cacheKey, { cachedAtMs: Date.now(), payload });
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

    const dense = await buildLlmBrainGraph(corpus, {
      range,
      source,
      onProgress: (progress) => setBrainBuildProgress(progressId, {
        ...progress,
        done: false,
      }),
    });
    const payload = {
      range,
      source,
      updatedAtMs: Date.now(),
      terms: dense.terms,
      connections: dense.connections,
      denseTerms: dense.terms,
      denseConnections: dense.connections,
      stats: {
        ...stats,
        llmChunks: dense.llmStats?.chunks || 0,
        llmCacheHits: dense.llmStats?.cacheHits || 0,
        llmGenerated: dense.llmStats?.generated || 0,
        llmFailed: dense.llmStats?.failed || 0,
      },
    };
    brainCloudCache.set(cacheKey, { cachedAtMs: Date.now(), payload });
    finishBrainBuildProgress(progressId, {
      phase: 'complete',
      doneChunks: dense.llmStats?.chunks || 0,
      totalChunks: dense.llmStats?.chunks || 0,
      remainingFiles: 0,
      cacheHits: dense.llmStats?.cacheHits || 0,
      generated: dense.llmStats?.generated || 0,
      failed: dense.llmStats?.failed || 0,
    });
    res.set('Cache-Control', 'no-store');
    res.json({ ...payload, cached: false });
  } catch (err) {
    finishBrainBuildProgress(normalizeBrainProgressId(req.query.progressId), {
      phase: 'error',
      error: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/brain/progress', (req, res) => {
  const id = normalizeBrainProgressId(req.query.id);
  const progress = id ? brainBuildProgress.get(id) : null;
  res.set('Cache-Control', 'no-store');
  res.json(progress || { phase: 'idle', done: true });
});

app.post('/api/brain/import-chat', (req, res) => {
  try {
    const provider = normalizeBrainImportProvider(req.body?.provider);
    const text = String(req.body?.content || '');
    const originalName = String(req.body?.filename || '').trim().slice(0, 180);
    if (!text.trim()) {
      res.status(400).json({ error: 'Choose an export file or paste a transcript first.' });
      return;
    }
    if (text.length > BRAIN_IMPORT_MAX_INPUT_CHARS) {
      res.status(413).json({ error: 'Import is too large for the dashboard. Try a smaller export file.' });
      return;
    }

    const conversations = extractBrainImportConversations(provider, text);
    if (!conversations.length) {
      res.status(400).json({ error: 'No conversations were found in that import.' });
      return;
    }

    const workspaceDir = getWorkspaceDir();
    const importId = brainImportId(provider, text);
    const importRoot = join(brainImportsDir(workspaceDir), safeBrainPathPart(provider), importId);
    const rawDir = join(importRoot, 'raw');
    const conversationsDir = join(importRoot, 'conversations');
    const manifestPath = join(importRoot, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        const filesExist = files.length > 0 && files.every((rel) => existsSync(join(importRoot, rel)));
        if (filesExist) {
          res.json({
            ok: true,
            reused: true,
            importId,
            provider,
            providerLabel: brainImportProviderLabel(provider),
            path: `brain-imports/${safeBrainPathPart(provider)}/${importId}`,
            conversations: Number(manifest.conversations) || conversations.length,
            messages: Number(manifest.messages) || conversations.reduce((sum, conv) => sum + conv.messages.length, 0),
            files: files.length,
            chars: Number(manifest.extractedChars) || 0,
          });
          return;
        }
      } catch (_) {}
    }
    if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
    if (!existsSync(conversationsDir)) mkdirSync(conversationsDir, { recursive: true });

    const rawName = safeBrainPathPart(originalName || `${provider}-export`, 'export') + '.raw.txt';
    writeFileSync(join(rawDir, rawName), text, 'utf8');

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

    const manifest = {
      importId,
      provider,
      providerLabel: brainImportProviderLabel(provider),
      originalName,
      contentHash: brainHashText(text),
      importedAt: new Date().toISOString(),
      raw: `raw/${rawName}`,
      status: 'extracted',
      conversations: conversations.length,
      messages: conversations.reduce((sum, conv) => sum + conv.messages.length, 0),
      extractedChars,
      files,
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    brainCloudCache.clear();

    res.json({
      ok: true,
      importId,
      provider,
      providerLabel: brainImportProviderLabel(provider),
      path: `brain-imports/${safeBrainPathPart(provider)}/${importId}`,
      conversations: conversations.length,
      messages: conversations.reduce((sum, conv) => sum + conv.messages.length, 0),
      files: files.length,
      chars: extractedChars,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  const { name, description, url, setup_notes } = req.body || {};
  if (!name || !String(name).trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    res.status(201).json(createProject({
      name: String(name).trim(),
      description: String(description || '').trim(),
      url: String(url || '').trim(),
      setup_notes: String(setup_notes || '').trim(),
    }));
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/projects/:id', (req, res) => {
  const { name, description, url, setup_notes, connectors } = req.body || {};
  const id = Number(req.params.id);
  const existing = getProject(id);
  if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
  const nextName = name !== undefined ? String(name || '').trim() : existing.name;
  if (!nextName) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const p = updateProject(id, {
      name: nextName,
      description: description !== undefined ? String(description || '').trim() : existing.description,
      url: url !== undefined ? String(url || '').trim() : undefined,
      setup_notes: setup_notes !== undefined ? String(setup_notes || '').trim() : undefined,
      connectors: connectors !== undefined && typeof connectors === 'object' ? connectors : undefined,
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
    execSync(`printf '%s' ${JSON.stringify(payload)} > ${JSON.stringify(dest)}`, { shell: true });
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
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' });
    const pids = out.trim().split(/\s+/).filter(Boolean);
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
