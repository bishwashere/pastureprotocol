#!/usr/bin/env node
/**
 * cowCode dashboard: web UI for status, crons, skills, LLM config.
 * Run: cowcode dashboard  (or pnpm run dashboard from repo)
 * Serves on port 3847 by default (COWCODE_DASHBOARD_PORT).
 */

import dotenv from 'dotenv';
import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'fs';
import { getConfigPath, getCronStorePath, getStateDir, getWorkspaceDir, getEnvPath, getAgentWorkspaceDir } from '../lib/paths.js';

// Use same state dir as main app (e.g. COWCODE_STATE_DIR from ~/.cowcode/.env)
dotenv.config({ path: getEnvPath() });
import { getResolvedTimezone, getResolvedTimeFormat } from '../lib/timezone.js';
import { loadStore } from '../cron/store.js';
import { DEFAULT_ENABLED } from '../skills/loader.js';
import { getGroupRestrictions, saveGroupRestrictions } from '../lib/group-config.js';
import { ensureMainAgentInitialized, loadAgentConfig, saveAgentConfig, listAgentIds, DEFAULT_AGENT_ID, resolveAgentIdForGroup, createAgent, deleteAgent } from '../lib/agent-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INSTALL_DIR = process.env.COWCODE_INSTALL_DIR || ROOT;
const PORT = Number(process.env.COWCODE_DASHBOARD_PORT) || 3847;
const HOST = process.env.COWCODE_DASHBOARD_HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '2mb' }));
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
      env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
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
// Set COWCODE_API_KEY in ~/.cowcode/.env to require Bearer token on all /api/* routes.
// Auth is enforced for remote access (e.g. Tailscale *.ts.net) but skipped for local dashboard use.
const API_KEY = process.env.COWCODE_API_KEY || '';
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

app.get('/api/status', async (_req, res) => {
  try {
    const daemonRunning = await getDaemonRunning();
    const dashboardUrl = `http://${HOST}:${PORT}`;
    res.json({ daemonRunning, dashboardUrl, port: PORT });
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
    const storePath = getCronStorePath();
    const store = loadStore(storePath);
    res.json({ jobs: store.jobs || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/skills', (_req, res) => {
  try {
    const config = loadConfig();
    const enabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : DEFAULT_ENABLED;
    const allIds = getAllSkillIds();
    const list = allIds.map((id) => ({ id, enabled: enabled.includes(id), description: getSkillDescription(id) }));
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
    config.skills.enabled = enabled;
    saveConfig(config);
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents', (_req, res) => {
  try {
    const ids = listAgentIds();
    const agents = ids.map((id) => {
      const config = loadAgentConfig(id);
      return {
        id,
        skillsEnabled: Array.isArray(config.skills?.enabled) ? config.skills.enabled : DEFAULT_ENABLED,
        hasLlm: !!config.llm,
      };
    });
    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:id/config', (req, res) => {
  try {
    const id = req.params.id || DEFAULT_AGENT_ID;
    const config = loadAgentConfig(id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/agents/:id/config', (req, res) => {
  try {
    const id = req.params.id || DEFAULT_AGENT_ID;
    const patch = req.body || {};
    const config = loadAgentConfig(id);
    if (patch.llm !== undefined) config.llm = patch.llm;
    if (patch.skills !== undefined) config.skills = patch.skills;
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
    const created = createAgent(rawId);
    const config = loadAgentConfig(created.id);
    res.status(created.created ? 201 : 200).json({ id: created.id, created: created.created, config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/:id', (req, res) => {
  try {
    const id = req.params.id || '';
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
    const allIds = getAllSkillIds();
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
    const allIds = getAllSkillIds();
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

// ---- Chat with LLM (dashboard chat space) ----

const CHAT_SCRIPT = join(INSTALL_DIR, 'scripts', 'chat-dashboard.js');

app.post('/api/chat', (req, res) => {
  const message = req.body?.message != null ? String(req.body.message).trim() : '';
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const agentId = req.body?.agentId != null ? String(req.body.agentId).trim() : '';
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }
  const payload = JSON.stringify({ message, history, agentId });
  const child = spawn(process.execPath, [CHAT_SCRIPT], {
    cwd: INSTALL_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR, COWCODE_INSTALL_DIR: INSTALL_DIR },
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

function getTestList() {
  const testDir = join(INSTALL_DIR, 'scripts', 'test');
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
    const name = id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') +
      (script.endsWith('-e2e.js') ? ' E2E' : '');
    list.push({ id, name, script, inputsPath: 'scripts/test/' + id + '/inputs.md' });
  }
  return list;
}

function runOneTest(testId) {
  const tests = getTestList();
  const test = tests.find((t) => t.id === testId);
  if (!test) return Promise.reject(new Error(`Unknown test: ${testId}`));
  const scriptPath = join(INSTALL_DIR, test.script);
  if (!existsSync(scriptPath)) return Promise.reject(new Error(`Script not found: ${test.script}`));
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [scriptPath], {
      cwd: INSTALL_DIR,
      env: { ...process.env, COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR, COWCODE_INSTALL_DIR: INSTALL_DIR },
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

  for (const raw of lines) {
    const t = raw.trim();
    if (/^##\s+Inputs/.test(t)) { inInputs = true; continue; }
    if (!inInputs) continue;
    if (/^##\s+/.test(t) && !/^###/.test(t)) break; // next h2 ends Inputs

    if (/^###\s+/.test(t)) {
      if (cur.messages.length || cur.group) groups.push(cur);
      cur = { group: t.replace(/^###\s*/, ''), messages: [] };
      tableMessageCol = -1;
      continue;
    }

    if (t.startsWith('|') && /Message/i.test(t)) {
      const cols = t.split('|').map(c => c.trim()).filter(Boolean);
      tableMessageCol = cols.findIndex(c => /^Message$/i.test(c));
      continue;
    }
    if (/^\|[\s\-|]+\|$/.test(t)) continue;

    if (tableMessageCol >= 0 && t.startsWith('|')) {
      const cols = t.split('|').map(c => c.trim()).filter(Boolean);
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
    const p = join(INSTALL_DIR, test.inputsPath);
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

// Static files
app.use(express.static(join(__dirname, 'public')));

app.get('/', (_req, res) => {
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
  console.log('  cowCode Dashboard');
  console.log('  ─────────────────');
  console.log(`  URL: http://${HOST}:${PORT}`);
  console.log('  (Use this URL to POST data for future features.)');
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Set COWCODE_DASHBOARD_PORT to another port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
