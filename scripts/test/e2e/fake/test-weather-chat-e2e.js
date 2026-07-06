#!/usr/bin/env node
/**
 * User-path E2E for weather phrasing:
 * user message -> index.js --test -> agent tool loop -> search skill -> reply.
 *
 * Fake-lane E2E: the LLM and weather endpoint are local fakes, so this does not send
 * repository prompts to external providers. The search skill still runs through
 * the real chat tool path by navigating to a local weather page.
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..');
const TIMEOUT_MS = 90_000;

const WEATHER_PHRASES = [
  'Hows the weather today',
  'Do I need an umbrella today?',
  'weather please',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function readJson(req) {
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

function latestUserText(messages) {
  const users = messages.filter((m) => m.role === 'user').map((m) => String(m.content || ''));
  for (let i = users.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(users[i]);
      const text = parsed?.latestUserMessage || parsed?.userText;
      if (typeof text === 'string' && text.trim()) return text;
    } catch {}
  }
  return users.findLast((text) => text.trim()) || '';
}

function fakePlannerJson() {
  return {
    workModeToggle: 'no_change',
    needsMultiAgent: false,
    needsDurability: false,
    needsDelegation: false,
    teamRouting: 'none',
    delegationAction: 'none',
    targetAgentId: '',
    mode: 'tool',
    skills: ['search'],
    executionMode: 'tool_use',
    usesExistingWorkIntake: false,
    mustUseTool: true,
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
    plan: 'Use search to navigate to the local fake weather page, then answer compactly.',
    answer_style: 'short',
    reason: 'Weather phrasing should route to search before answering.',
  };
}

function startWeatherServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body><main>Enola, PA weather today: high near 82F. Showers and thunderstorms possible after 2pm. Precipitation chance 50%.</main></body></html>');
  });
  return listen(server).then((port) => ({ server, port }));
}

function startFakeLlmServer(weatherUrl) {
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const body = await readJson(req);
    calls.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const promptText = messages.map((m) => String(m.content || '')).join('\n');
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (promptText.includes('Unified Turn Planner')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify(fakePlannerJson()) } }] });
      return;
    }

    if (promptText.includes('Task Frame Router')) {
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
        reason: 'Standalone weather phrasing is not task-frame work.',
      }) } }] });
      return;
    }

    if (promptText.includes('Work-Mode Classifier') || promptText.includes('Work Mode Classifier') || promptText.includes('work-mode')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"toggle":"no_change","reason":"weather request"}' } }] });
      return;
    }

    if (promptText.includes('Task Frame Status')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"status":"continue","confidence":0.8,"reason":"Weather phrasing test can continue."}' } }] });
      return;
    }

    if (promptText.includes('self-inspection') || promptText.includes('Self-Inspection')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"is_self_inspection":false,"needs_tools":false,"target":"none","starting_points":[],"reason":"Weather request."}' } }] });
      return;
    }

    if (hasTools && !hasToolResult) {
      jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_weather_1',
              type: 'function',
              function: {
                name: 'search_navigate',
                arguments: JSON.stringify({ url: weatherUrl }),
              },
            }],
          },
        }],
      });
      return;
    }

    const userText = latestUserText(messages);
    const prefix = /umbrella/i.test(userText) ? 'Yes, keep an umbrella handy. ' : '';
    jsonResponse(res, {
      choices: [{
        message: {
          role: 'assistant',
          content: `${prefix}Enola, PA today: high near 82F, with showers and thunderstorms possible after 2pm. Keep an umbrella handy.`,
        },
      }],
    });
  });
  return listen(server).then((port) => ({ server, port, calls }));
}

function createStateDir(fakeLlmPort) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-weather-chat-e2e-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    llm: {
      models: [{
        provider: 'lmstudio',
        baseUrl: `http://127.0.0.1:${fakeLlmPort}/v1`,
        model: 'fake-weather-chat',
        apiKey: 'not-needed',
      }],
      localRpm: 999,
      maxTokens: 1000,
    },
    skills: {
      enabled: ['search'],
    },
  }, null, 2));
  return stateDir;
}

function runChat(message, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js', '--test', message], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const start = stdout.indexOf('E2E_REPLY_START');
      const end = stdout.indexOf('E2E_REPLY_END');
      if (start === -1 || end === -1 || end <= start) {
        reject(new Error(`No E2E reply markers (exit ${code}). stderr: ${stderr.slice(-500)} stdout: ${stdout.slice(-1000)}`));
        return;
      }
      const reply = stdout.slice(start + 'E2E_REPLY_START'.length, end).trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch ? skillsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${reply}`));
        return;
      }
      resolve({ reply, skillsCalled, stdout });
    });
  });
}

async function main() {
  const weather = await startWeatherServer();
  const fakeLlm = await startFakeLlmServer(`http://127.0.0.1:${weather.port}/weather`);
  const stateDir = createStateDir(fakeLlm.port);
  try {
    for (const phrase of WEATHER_PHRASES) {
      const { reply, skillsCalled, stdout } = await runChat(phrase, stateDir);
      assert(
        skillsCalled.includes('search'),
        `${phrase}: expected search skill, got [${skillsCalled.join(', ')}]. stdout tail: ${stdout.slice(-1200)}`
      );
      assert(/Enola, PA today/i.test(reply), `${phrase}: expected compact Enola answer, got: ${reply}`);
      assert(/umbrella/i.test(reply), `${phrase}: expected practical umbrella guidance, got: ${reply}`);
      assert(!/\?$/.test(reply.trim()), `${phrase}: reply should not end by asking a question: ${reply}`);
      assert(!/need your exact location|which location|where are you/i.test(reply), `${phrase}: should not ask location first: ${reply}`);
      assert(reply.length <= 180, `${phrase}: reply should be compact, got ${reply.length} chars: ${reply}`);
    }
    console.log(`weather chat E2E passed (${WEATHER_PHRASES.length} phrasings)`);
  } finally {
    fakeLlm.server.close();
    weather.server.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
