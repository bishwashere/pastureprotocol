#!/usr/bin/env node
/**
 * Synthetic multi-turn weather conversation.
 *
 * Runs the real index.js --test chat path with a local fake LLM and local fake
 * weather page. This does not test Telegram transport; it tests the Pasture
 * turn flow, logs, tool exposure, and replies.
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
const TEST_JID = 'synthetic-weather@s.whatsapp.net';

const TURNS = [
  "What's the weather in Enola today?",
  'Do I need an umbrella later?',
  'What about tomorrow morning?',
  'How humid will it feel tonight?',
  'Thanks',
];

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

function startWeatherServer() {
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

function latestText(messages) {
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

function plannerJson(skills, userText) {
  const wantsWeather = /weather|umbrella|tomorrow|humid|humidity|rain|shower/i.test(userText);
  const searchSkill = skills.includes('search') ? ['search'] : [];
  return {
    workModeToggle: 'no_change',
    needsMultiAgent: false,
    needsDurability: false,
    needsDelegation: false,
    teamRouting: 'none',
    delegationAction: 'none',
    targetAgentId: '',
    mode: wantsWeather ? 'tool' : 'chat',
    skills: wantsWeather ? searchSkill : [],
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
    plan: wantsWeather ? 'Use search to answer the weather follow-up compactly.' : 'Answer directly.',
    answer_style: 'short',
    reason: wantsWeather ? 'Weather and weather follow-ups need current data.' : 'Casual chat does not need tools.',
  };
}

function answerFor(userText) {
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
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !String(req.url || '').endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const body = await readJson(req);
    calls.push(body);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = String(messages.find((m) => m.role === 'system')?.content || '');
    const userText = latestText(messages);
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
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify(plannerJson(available, userText)) } }] });
      return;
    }

    if (system.includes('Task Frame Status')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"status":"continue","confidence":0.8,"reason":"Weather conversation can continue normally."}' } }] });
      return;
    }

    if (tools.length && !hasToolResult && /weather|umbrella|tomorrow|humid|humidity|rain|shower/i.test(userText)) {
      const name = toolNames.find((n) => n.includes('navigate')) || toolNames.find((n) => n.includes('search')) || toolNames[0];
      const path = /tomorrow/i.test(userText) ? '/tomorrow' : (/humid|humidity|tonight/i.test(userText) ? '/humidity' : '/today');
      const args = name.includes('navigate')
        ? { url: `${weatherBaseUrl}${path}` }
        : { query: `Enola PA weather ${userText}` };
      jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: `call_${calls.length}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            }],
          },
        }],
      });
      return;
    }

    jsonResponse(res, { choices: [{ message: { role: 'assistant', content: answerFor(userText) } }] });
  });
  return listen(server).then((port) => ({ server, port, calls }));
}

function createStateDir(fakeLlmPort) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-weather-convo-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
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
      enabled: ['search'],
    },
  }, null, 2));
  return stateDir;
}

function runTurn(message, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js', '--test', message, '--test-jid', TEST_JID], {
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
        reject(new Error(`No E2E reply markers (exit ${code}). stderr: ${stderr.slice(-800)} stdout: ${stdout.slice(-1200)}`));
        return;
      }
      const reply = stdout
        .slice(start + 'E2E_REPLY_START'.length, end)
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => !/^\[\d{4}-\d{2}-\d{2}T/.test(line.trim()))
        .join('\n')
        .trim();
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

function interestingLogLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) =>
      line.includes('[USER]') ||
      line.includes('[AGENT]') ||
      /\[(\d+ [A-Z ]+)\]/.test(line) ||
      /\[LLM\]/.test(line) ||
      /E2E_SKILLS_CALLED|E2E_REPLY_START|E2E_REPLY_END/.test(line)
    )
    .filter((line) => !line.includes('E2E_REPLY_START') && !line.includes('E2E_REPLY_END'));
}

async function main() {
  const weather = await startWeatherServer();
  const fakeLlm = await startFakeLlmServer(`http://127.0.0.1:${weather.port}`);
  const stateDir = createStateDir(fakeLlm.port);
  try {
    console.log('SYNTHETIC_WEATHER_CONVERSATION_START');
    console.log('STATE_DIR', stateDir);
    for (let i = 0; i < TURNS.length; i += 1) {
      const user = TURNS[i];
      const result = await runTurn(user, stateDir);
      console.log(`\nTURN ${i + 1}`);
      console.log('USER:', user);
      console.log('REPLY:', result.reply);
      console.log('SKILLS:', result.skillsCalled.join(',') || '(none)');
      console.log('LOGS:');
      for (const line of interestingLogLines(result.stdout).slice(0, 80)) {
        console.log(line);
      }
    }
    console.log('\nSYNTHETIC_WEATHER_CONVERSATION_END');
  } finally {
    fakeLlm.server.close();
    weather.server.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
