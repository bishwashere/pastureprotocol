#!/usr/bin/env node
/**
 * Sandboxed live log conversation driver.
 *
 * Default mode drives the real index.js --test-live path with real configured
 * LLMs and real skills/tools. --fake mode uses a local fake LLM plus local fake
 * weather endpoint for deterministic log-shape tests. Both modes isolate the
 * child process in a temporary PASTURE_STATE_DIR so the test cannot mutate the
 * user's real chat history, task frames, memory index, cron store, or agent
 * working state. When --write-daemon-log is present, the live child logs are
 * also appended to the user's normal daemon log so `pasture logs` can watch the
 * run.
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const SOURCE_STATE_DIR = process.env.PASTURE_SOURCE_STATE_DIR || join(homedir(), '.pasture');
const SOURCE_CONFIG_PATH = join(SOURCE_STATE_DIR, 'config.json');
const TIMEOUT_MS = Number(process.env.PASTURE_TEST_LOGS_TIMEOUT_MS || 180_000);
const FAKE_MODE = process.argv.includes('--fake') || process.argv.includes('--mock');
const TEST_JID = process.env.PASTURE_TEST_LOGS_JID || (FAKE_MODE ? 'fake-log-test@s.whatsapp.net' : 'live-log-test@s.whatsapp.net');
const KEEP_STATE = process.argv.includes('--keep-state');
const WRITE_DAEMON_LOG = process.argv.includes('--write-daemon-log');
const DAEMON_LOG_PATH = process.env.PASTURE_DAEMON_LOG_PATH || join(homedir(), '.pasture', 'daemon.log');

const TURNS = [
  "What's the weather in Enola today?",
  'Do I need an umbrella later?',
  'What about tomorrow morning?',
  'How humid will it feel tonight?',
  'Thanks',
];

const TOP_LEVEL_SEED_FILES = [
  'config.json',
  'secrets.json',
  '.env',
  'teams.json',
  'projects.db',
];

const AGENT_SEED_FILES = new Set([
  'config.json',
  'SOUL.md',
  'WhoAmI.md',
  'MyHuman.md',
  'avatar.png',
]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readRequestJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function jsonResponse(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonFile(path, fallback = {}) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function redirectStatePaths(value, sourceStateDir, targetStateDir) {
  if (Array.isArray(value)) {
    return value.map((item) => redirectStatePaths(item, sourceStateDir, targetStateDir));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redirectStatePaths(inner, sourceStateDir, targetStateDir);
    }
    return out;
  }
  if (typeof value !== 'string') return value;
  if (!value.startsWith(sourceStateDir)) return value;
  const suffix = value.slice(sourceStateDir.length).replace(/^\/+/, '');
  return suffix ? join(targetStateDir, suffix) : targetStateDir;
}

function sandboxConfig(config, stateDir) {
  const next = redirectStatePaths(cloneJson(config), SOURCE_STATE_DIR, stateDir);
  if (!next.memory || typeof next.memory !== 'object') next.memory = {};
  next.memory.workspaceDir = join(stateDir, 'workspace');
  next.memory.indexPath = join(stateDir, 'memory', 'index.db');
  return next;
}

function startFakeWeatherServer() {
  const server = createServer((req, res) => {
    const url = String(req.url || '');
    res.writeHead(200, { 'content-type': 'text/html' });
    if (url.includes('tomorrow')) {
      res.end('<main>Enola, PA tomorrow morning: 68F to 73F, mostly cloudy, isolated shower chance around 20%, light southeast breeze.</main>');
      return;
    }
    if (url.includes('humidity')) {
      res.end('<main>Enola, PA tonight: around 72F, humidity near 78%, muggy feel, light shower chance after sunset.</main>');
      return;
    }
    res.end('<main>Enola, PA today: high near 82F. Showers and thunderstorms possible after 2pm. Precipitation chance 50%.</main>');
  });
  return listen(server).then((port) => ({ server, port }));
}

function latestUserText(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  for (let i = users.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(users[i]);
      const text = parsed?.latestUserMessage || parsed?.userText;
      if (typeof text === 'string' && text.trim()) return text;
    } catch {}
  }
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const raw = users[i];
    if (!raw.trim()) continue;
    if (raw.includes('# Final Reply Policy')) continue;
    if (raw.includes('"availableSkills"') || raw.includes('"latestUserMessage"')) continue;
    return raw;
  }
  return users.at(-1) || '';
}

function fakePlannerJson(skills, userText) {
  const wantsWeather = /weather|umbrella|tomorrow|humid|humidity|rain|shower/i.test(userText);
  const httpSkill = skills.includes('http') ? ['http'] : [];
  return {
    workModeToggle: 'no_change',
    needsMultiAgent: false,
    needsDurability: false,
    needsDelegation: false,
    teamRouting: 'none',
    delegationAction: 'none',
    targetAgentId: '',
    mode: wantsWeather ? 'tool' : 'chat',
    skills: wantsWeather ? httpSkill : [],
    executionMode: wantsWeather ? 'tool_use' : 'direct_answer',
    usesExistingWorkIntake: false,
    mustUseTool: wantsWeather,
    fallbackToolPolicy: 'no_tools',
    projectOrMissionIntent: 'none',
    githubSourceIntent: false,
    taskFrameAction: 'none',
    taskFrameSeedPolicy: 'reject_candidate',
    taskFrameStatusHint: 'continue',
    taskFrame: {
      kind: 'general_task',
      title: '',
      objective: '',
      projectName: '',
      repoUrl: '',
      localPath: '',
      ownerAgentId: '',
      teamId: '',
      toolProfile: [],
      plan: '',
    },
    plan: wantsWeather ? 'Use http_get against the fake weather endpoint and answer compactly.' : 'Answer directly.',
    answer_style: 'short',
    reason: wantsWeather ? 'Weather and weather follow-ups need current data from the fake weather endpoint.' : 'Casual chat does not need tools.',
  };
}

function fakeAnswerFor(userText) {
  if (/tomorrow/i.test(userText)) {
    return 'Tomorrow morning in Enola looks mild: about 68F to 73F, mostly cloudy, with only an isolated shower chance.';
  }
  if (/humid|humidity|tonight/i.test(userText)) {
    return 'Tonight should feel a bit muggy in Enola: around 72F with humidity near 78%, plus a small shower chance.';
  }
  if (/umbrella|later|rain|shower/i.test(userText)) {
    return 'Yes, bring an umbrella later. Enola has showers or storms possible after 2pm, with about a 50% rain chance.';
  }
  if (/thank/i.test(userText)) {
    return "You're welcome.";
  }
  return 'Enola today: high near 82F, with showers and thunderstorms possible after 2pm. Umbrella is a good idea.';
}

function startFakeLlmServer(weatherBaseUrl) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const body = await readRequestJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((m) => m.role === 'system')?.content || '');
    const userText = latestUserText(messages);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.map((t) => t?.function?.name).filter(Boolean);
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (system.includes('Work-Mode Classifier')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"toggle":"no_change","reason":"No work-mode toggle requested."}' } }] });
      return;
    }

    if (system.includes('Task Frame Router')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify({
        action: 'ignore',
        confidence: 0.9,
        mustUseTool: false,
        resemblance: 'none',
        kind: 'general_task',
        title: '',
        objective: '',
        projectName: '',
        repoUrl: '',
        localPath: '',
        toolProfile: [],
        plan: '',
        reason: 'Weather chat is not task-frame work.',
      }) } }] });
      return;
    }

    if (system.includes('Unified Turn Planner')) {
      let available = [];
      try {
        const parsed = JSON.parse(messages.at(-1)?.content || '{}');
        if (Array.isArray(parsed.availableSkillIds)) {
          available = parsed.availableSkillIds;
        } else if (Array.isArray(parsed.availableSkills)) {
          available = parsed.availableSkills.map((skill) => skill?.id).filter(Boolean);
        }
      } catch {}
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify(fakePlannerJson(available, userText)) } }] });
      return;
    }

    if (system.includes('Task Frame Status')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"status":"continue","confidence":0.8,"reason":"Weather conversation can continue normally."}' } }] });
      return;
    }

    if (tools.length && !hasToolResult && /weather|umbrella|tomorrow|humid|humidity|rain|shower/i.test(userText)) {
      const name = toolNames.find((n) => n === 'http_get') || toolNames.find((n) => n.includes('http')) || toolNames[0];
      const path = /tomorrow/i.test(userText) ? '/tomorrow' : (/humid|humidity|tonight/i.test(userText) ? '/humidity' : '/today');
      jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_fake_weather',
              type: 'function',
              function: { name, arguments: JSON.stringify({ url: `${weatherBaseUrl}${path}`, timeoutMs: 5000 }) },
            }],
          },
        }],
      });
      return;
    }

    jsonResponse(res, { choices: [{ message: { role: 'assistant', content: fakeAnswerFor(userText) } }] });
  });
  return listen(server).then((port) => ({ server, port }));
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return true;
}

function copyTopLevelSeedFiles(stateDir) {
  for (const name of TOP_LEVEL_SEED_FILES) {
    const src = join(SOURCE_STATE_DIR, name);
    const dest = join(stateDir, name);
    if (name === 'config.json' && existsSync(src)) {
      writeJsonFile(dest, sandboxConfig(readJsonFile(src), stateDir));
      continue;
    }
    copyIfExists(src, dest);
  }
}

function copyAgentSeeds(stateDir) {
  const sourceAgentsDir = join(SOURCE_STATE_DIR, 'agents');
  if (!existsSync(sourceAgentsDir)) return;
  for (const entry of readdirSync(sourceAgentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentDir = join(sourceAgentsDir, entry.name);
    const targetAgentDir = join(stateDir, 'agents', basename(entry.name));
    mkdirSync(targetAgentDir, { recursive: true });
    for (const child of readdirSync(agentDir, { withFileTypes: true })) {
      if (!child.isFile() || !AGENT_SEED_FILES.has(child.name)) continue;
      const src = join(agentDir, child.name);
      const dest = join(targetAgentDir, child.name);
      if (child.name === 'config.json') {
        writeJsonFile(dest, sandboxConfig(readJsonFile(src), stateDir));
      } else {
        copyIfExists(src, dest);
      }
    }
  }
}

function ensureMainAgentConfig(stateDir) {
  const mainConfigPath = join(stateDir, 'agents', 'main', 'config.json');
  if (existsSync(mainConfigPath)) return;
  mkdirSync(dirname(mainConfigPath), { recursive: true });
  const config = readJsonFile(join(stateDir, 'config.json'), {});
  writeJsonFile(mainConfigPath, config);
}

function createFakeStateDir(fakeLlmPort) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-fake-log-test-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  mkdirSync(join(stateDir, 'memory'), { recursive: true });
  const config = {
    llm: {
      models: [{
        provider: 'lmstudio',
        baseUrl: `http://127.0.0.1:${fakeLlmPort}/v1`,
        model: 'fake-weather-conversation',
        apiKey: 'not-needed',
      }],
      localRpm: 999,
      maxTokens: 1000,
    },
    skills: {
      enabled: ['http'],
    },
    memory: {
      enabled: false,
      workspaceDir: join(stateDir, 'workspace'),
      indexPath: join(stateDir, 'memory', 'index.db'),
    },
  };
  writeJsonFile(join(stateDir, 'config.json'), config);
  writeJsonFile(join(stateDir, 'agents', 'main', 'config.json'), config);
  return stateDir;
}

function createRealStateDir() {
  if (!existsSync(SOURCE_CONFIG_PATH)) {
    throw new Error(`Cannot run live log test: missing source config at ${SOURCE_CONFIG_PATH}`);
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-live-log-test-'));
  for (const dir of ['workspace', 'memory', 'cron', 'background-tasks', 'agents']) {
    mkdirSync(join(stateDir, dir), { recursive: true });
  }
  copyTopLevelSeedFiles(stateDir);
  copyAgentSeeds(stateDir);
  ensureMainAgentConfig(stateDir);
  return stateDir;
}

function writeDaemonLog(chunk) {
  if (!WRITE_DAEMON_LOG) return;
  mkdirSync(dirname(DAEMON_LOG_PATH), { recursive: true });
  appendFileSync(DAEMON_LOG_PATH, chunk, 'utf8');
}

function runLiveConversation(stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js', '--test-live', '--test-jid', TEST_JID], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: stateDir, PASTURE_E2E_LIVE_LOG: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let nextTurnIndex = 0;
    let completedCycles = 0;
    let finished = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    function sendNextTurn() {
      if (finished || nextTurnIndex >= TURNS.length) return;
      child.stdin.write(`${TURNS[nextTurnIndex]}\n`);
      nextTurnIndex += 1;
      if (nextTurnIndex >= TURNS.length) child.stdin.end();
    }
    function countCycleEnds(chunk) {
      let count = 0;
      let idx = String(chunk).indexOf('[END CYCLE]');
      while (idx >= 0) {
        count += 1;
        idx = String(chunk).indexOf('[END CYCLE]', idx + 1);
      }
      return count;
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      writeDaemonLog(chunk);
      completedCycles += countCycleEnds(chunk);
      if (completedCycles >= nextTurnIndex && nextTurnIndex < TURNS.length) {
        setTimeout(sendNextTurn, 250);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
      writeDaemonLog(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      finished = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. stderr: ${stderr.slice(-800)}`));
        return;
      }
      if (completedCycles < TURNS.length) {
        reject(new Error(`Only completed ${completedCycles}/${TURNS.length} live turns.`));
        return;
      }
      resolve();
    });
    sendNextTurn();
  });
}

async function main() {
  let fakeWeather = null;
  let fakeLlm = null;
  let stateDir = '';
  try {
    if (FAKE_MODE) {
      fakeWeather = await startFakeWeatherServer();
      fakeLlm = await startFakeLlmServer(`http://127.0.0.1:${fakeWeather.port}`);
      stateDir = createFakeStateDir(fakeLlm.port);
    } else {
      stateDir = createRealStateDir();
    }
    await runLiveConversation(stateDir);
  } finally {
    fakeLlm?.server?.close();
    fakeWeather?.server?.close();
    if (stateDir && !KEEP_STATE) {
      const marker = statSync(stateDir, { throwIfNoEntry: false });
      if (marker?.isDirectory() && (stateDir.includes('pasture-live-log-test-') || stateDir.includes('pasture-fake-log-test-'))) {
        rmSync(stateDir, { recursive: true, force: true });
      }
    } else if (stateDir) {
      console.error(`[test-logs] kept sandbox state at ${stateDir}`);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
