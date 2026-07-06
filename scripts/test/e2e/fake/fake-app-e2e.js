#!/usr/bin/env node
import { createServer } from 'http';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..');
const TIMEOUT_MS = 60_000;

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

function stripToolDoc(text) {
  return String(text || '').split('\n\n---\n')[0];
}

function latestToolText(messages) {
  const toolMessages = messages.filter((m) => m.role === 'tool').map((m) => String(m.content || ''));
  return toolMessages[toolMessages.length - 1] || '';
}

function fakePlannerJson(scenario) {
  return {
    workModeToggle: scenario.workModeToggle || 'no_change',
    needsMultiAgent: false,
    needsDurability: false,
    needsDelegation: false,
    teamRouting: 'none',
    delegationAction: 'none',
    targetAgentId: '',
    mode: scenario.toolCall ? 'tool' : 'chat',
    skills: scenario.skills || [],
    executionMode: scenario.toolCall ? 'tool_use' : 'direct_answer',
    usesExistingWorkIntake: false,
    mustUseTool: Boolean(scenario.toolCall),
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
    plan: scenario.plan || 'Run the planned fake E2E step and answer compactly.',
    answer_style: 'short',
    reason: scenario.reason || 'Deterministic fake E2E route.',
  };
}

function fakeTaskFrameJson() {
  return {
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
    reason: 'Fake E2E uses normal path.',
  };
}

function finalReplyFor(scenario, messages) {
  if (typeof scenario.finalReply === 'function') {
    return scenario.finalReply(stripToolDoc(latestToolText(messages)), messages);
  }
  return scenario.finalReply || `${scenario.name} fake E2E completed.`;
}

async function startTextServer(text) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(text);
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function startHaServer() {
  const states = [
    {
      entity_id: 'light.fake_living_room',
      state: 'on',
      attributes: { friendly_name: 'Fake Living Room Light' },
    },
    {
      entity_id: 'sensor.fake_temperature',
      state: '72',
      attributes: { friendly_name: 'Fake Temperature', unit_of_measurement: 'F' },
    },
  ];
  const server = createServer((req, res) => {
    if (req.url === '/api/states') return jsonResponse(res, states);
    if (req.url === '/api/states/light.fake_living_room') return jsonResponse(res, states[0]);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
}

async function startFakeLlmServer(scenario) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const promptText = messages.map((m) => String(m.content || '')).join('\n');
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (promptText.includes('Unified Turn Planner')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify(fakePlannerJson(scenario)) } }] });
    }
    if (promptText.includes('Task Frame Router')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: JSON.stringify(fakeTaskFrameJson()) } }] });
    }
    if (promptText.includes('Work-Mode Classifier') || promptText.includes('Work Mode Classifier') || promptText.includes('work-mode')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"toggle":"no_change","reason":"fake e2e"}' } }] });
    }
    if (promptText.includes('Task Frame Status')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"status":"continue","confidence":0.8,"reason":"fake e2e complete"}' } }] });
    }
    if (promptText.includes('Casual') || promptText.includes('casual')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: scenario.finalReply || 'Hi. How can I help?' } }] });
    }
    if (hasTools && !hasToolResult && scenario.toolCall) {
      return jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_fake_1',
              type: 'function',
              function: {
                name: scenario.toolCall.name,
                arguments: JSON.stringify(scenario.toolCall.arguments || {}),
              },
            }],
          },
        }],
      });
    }
    return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: finalReplyFor(scenario, messages) } }] });
  });
  const port = await listen(server);
  return { server, port };
}

function createStateDir(scenario, fakeLlmPort) {
  const stateDir = join(tmpdir(), `pasture-${scenario.name}-fake-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(join(stateDir, 'cron'), { recursive: true });
  mkdirSync(join(stateDir, 'agents', 'main'), { recursive: true });
  for (const [rel, content] of Object.entries(scenario.files || {})) {
    const path = join(workspaceDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (Buffer.isBuffer(content)) writeFileSync(path, content);
    else writeFileSync(path, content, 'utf8');
  }
  const config = {
    llm: {
      models: [{
        provider: 'lmstudio',
        baseUrl: `http://127.0.0.1:${fakeLlmPort}/v1`,
        model: `fake-${scenario.name}`,
        apiKey: 'not-needed',
      }],
      localRpm: 999,
      maxTokens: 1000,
    },
    skills: {
      enabled: scenario.skills || [],
      ...(scenario.skillConfig || {}),
    },
  };
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  writeFileSync(join(stateDir, 'agents', 'main', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  if (scenario.envFile) writeFileSync(join(stateDir, '.env'), scenario.envFile, 'utf8');
  return stateDir;
}

function runChat(message, stateDir, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js', '--test', message], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv, PASTURE_STATE_DIR: stateDir },
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
        reject(new Error(`No E2E reply markers (exit ${code}). stderr: ${stderr.slice(-500)} stdout: ${stdout.slice(-1200)}`));
        return;
      }
      const reply = stdout.slice(start + 'E2E_REPLY_START'.length, end).trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch ? skillsMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${reply}`));
        return;
      }
      resolve({ reply, skillsCalled, stdout, stderr });
    });
  });
}

function makeScenarios() {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    'agent': { name: 'agent', message: 'Hello, what is 2+2?', skills: [], finalReply: 'Hello. 2+2 is 4.' },
    'casual-greetings-e2e': { name: 'casual-greetings-e2e', message: 'hi', skills: [], finalReply: 'Hi. How can I help?' },
    'basic-e2e': { name: 'basic-e2e', message: 'hello and what is 17 times 13?', skills: [], finalReply: 'Hello. 17 times 13 is 221.' },
    'agent-team-e2e': { name: 'agent-team-e2e', message: 'What tagline should marketing use?', skills: [], finalReply: 'Marketing should use: Build calmly. Ship clearly.' },
    'project-workflow-e2e': {
      name: 'project-workflow-e2e',
      message: 'Create a tiny project plan.',
      skills: ['project-workflow'],
      toolCall: { name: 'project_workflow_status', arguments: {} },
      finalReply: 'Project workflow fake E2E checked project status and returned a plan.',
    },
    'dashboard-browser-e2e': { name: 'dashboard-browser-e2e', message: 'Dashboard health?', skills: [], finalReply: 'Dashboard fake E2E reached the chat path.' },
    'write-e2e': {
      name: 'write-e2e',
      message: 'Write a note file.',
      skills: ['write'],
      toolCall: { name: 'write_file', arguments: { path: 'note.txt', content: 'fake write e2e' } },
      finalReply: 'Wrote note.txt with fake write e2e.',
      assert: ({ reply, skillsCalled }) => {
        assert(skillsCalled.includes('write'), 'write skill was not called');
        assert(/note\.txt/.test(reply), 'reply did not mention note.txt');
      },
    },
    'edit-e2e': {
      name: 'edit-e2e',
      message: 'Edit the fixture file.',
      skills: ['edit'],
      files: { 'edit.txt': 'color=red\n' },
      toolCall: { name: 'edit_file', arguments: { path: 'edit.txt', oldString: 'red', newString: 'blue' } },
      finalReply: 'Edited edit.txt from red to blue.',
    },
    'apply-patch-e2e': {
      name: 'apply-patch-e2e',
      message: 'Apply the fixture patch.',
      skills: ['apply-patch'],
      files: { 'patch.txt': 'one\ntwo\nthree' },
      toolCall: { name: 'apply_patch_apply', arguments: { path: 'patch.txt', hunk: ' one\n-two\n+TWO\n three' } },
      finalReply: 'Applied the patch to patch.txt.',
    },
    'go-read-e2e': {
      name: 'go-read-e2e',
      message: 'List workspace files.',
      skills: ['go-read'],
      files: { 'listed.txt': 'fake go-read e2e' },
      toolCall: { name: 'go_read_run', arguments: { command: 'ls', argv: ['-1'] } },
      finalReply: 'Workspace listing includes listed.txt.',
    },
    'go-write-e2e': {
      name: 'go-write-e2e',
      message: 'Create a folder.',
      skills: ['go-write'],
      toolCall: { name: 'go_write_run', arguments: { command: 'mkdir', argv: ['made-by-go-write'] } },
      finalReply: 'Created made-by-go-write.',
    },
    'cron-e2e': {
      name: 'cron-e2e',
      message: 'Remind me soon.',
      skills: ['cron'],
      toolCall: { name: 'cron_add', arguments: { job: { message: 'fake cron e2e', schedule: { kind: 'at', at: future } } } },
      finalReply: 'Reminder created for fake cron e2e.',
    },
    'speech-e2e': {
      name: 'speech-e2e',
      message: 'Reply as voice.',
      skills: ['speech'],
      toolCall: { name: 'speech_reply_as_voice', arguments: { text: 'fake speech e2e' } },
      finalReply: 'Voice reply queued for fake speech e2e.',
    },
    'me-e2e': {
      name: 'me-e2e',
      message: 'What do you know about me?',
      skills: ['me'],
      files: { 'MEMORY.md': 'Bishwas likes deterministic fake E2E tests.' },
      toolCall: { name: 'me_profile', arguments: {} },
      finalReply: 'You like deterministic fake E2E tests.',
    },
    'memory-e2e': {
      name: 'memory-e2e',
      message: 'Remember that fake memory works.',
      skills: ['memory'],
      toolCall: { name: 'memory_save', arguments: { content: 'fake memory works', path: 'MEMORY.md' } },
      finalReply: 'Saved fake memory works.',
    },
    'home-assistant-e2e': {
      name: 'home-assistant-e2e',
      message: 'List my fake lights.',
      skills: ['home-assistant'],
      toolCall: { name: 'home_assistant_run', arguments: { command: 'list light' } },
      finalReply: 'Fake Living Room Light is on.',
      setup: async () => ({ ha: await startHaServer() }),
      envFromSetup: ({ ha }) => ({ envFile: `HA_URL=${ha.url}\nHA_TOKEN=fake-token\n` }),
      cleanup: ({ ha }) => ha.server.close(),
    },
    'gog-e2e': {
      name: 'gog-e2e',
      message: 'Check fake gog auth.',
      skills: ['gog'],
      toolCall: { name: 'gog_run', arguments: { action: 'run', argv: ['auth', 'status', '--json', '--no-input'] } },
      finalReply: 'Fake gog auth status is ok.',
      setup: async () => {
        const binDir = join(tmpdir(), `pasture-fake-gog-${Date.now()}`);
        mkdirSync(binDir, { recursive: true });
        const bin = join(binDir, 'gog');
        writeFileSync(bin, '#!/bin/sh\necho \'{"ok":true,"account":"fake@example.com"}\'\n', 'utf8');
        chmodSync(bin, 0o755);
        return { binDir };
      },
      extraEnvFromSetup: ({ binDir }) => ({ PATH: `${binDir}:${process.env.PATH || ''}` }),
    },
    'server-inspect-e2e': {
      name: 'server-inspect-e2e',
      message: 'Inspect fake server.',
      skills: ['ssh-inspect'],
      toolCall: { name: 'ssh_inspect_run', arguments: { host: 'missing-test-server', command: 'uptime', argv: [] } },
      finalReply: 'Server inspection returned a controlled unavailable-server result.',
    },
    'vision-e2e': {
      name: 'vision-e2e',
      message: 'Describe the fake image.',
      skills: ['vision'],
      files: { 'pixel.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64') },
      toolCall: { name: 'vision_describe', arguments: { path: 'pixel.png', prompt: 'Describe this tiny image.' } },
      finalReply: 'The fake image is a tiny pixel fixture.',
    },
  };
}

function scenarioFor(name) {
  const scenarios = makeScenarios();
  if (name === 'browser-e2e') {
    return {
      name,
      message: 'Open the fake page.',
      skills: ['browse'],
      setup: async () => ({ page: await startTextServer('<html><body>Fake browse E2E page loaded.</body></html>') }),
      applySetup: (scenario, setup) => {
        scenario.toolCall = { name: 'browse_navigate', arguments: { action: 'navigate', url: setup.page.url } };
      },
      finalReply: 'Fake browse E2E page loaded.',
      cleanup: ({ page }) => page.server.close(),
    };
  }
  if (name === 'core-e2e') {
    return scenarios['basic-e2e'];
  }
  return scenarios[name];
}

export async function runNamedFakeE2E(name) {
  const scenario = scenarioFor(name);
  if (!scenario) throw new Error(`No fake E2E scenario registered for ${name}`);
  let setup = {};
  let fakeLlm;
  try {
    if (scenario.setup) setup = await scenario.setup();
    if (scenario.applySetup) scenario.applySetup(scenario, setup);
    if (scenario.envFromSetup) Object.assign(scenario, scenario.envFromSetup(setup));
    fakeLlm = await startFakeLlmServer(scenario);
    const stateDir = createStateDir(scenario, fakeLlm.port);
    const extraEnv = scenario.extraEnvFromSetup ? scenario.extraEnvFromSetup(setup) : {};
    const result = await runChat(scenario.message, stateDir, extraEnv);
    if (scenario.toolCall) {
      const expectedSkill = (scenario.skills || [])[0];
      assert(
        !expectedSkill || result.skillsCalled.includes(expectedSkill),
        `expected skill ${expectedSkill}, got [${result.skillsCalled.join(', ')}]`
      );
    }
    if (scenario.assert) scenario.assert(result);
    console.log(`${name} fake E2E passed`);
  } finally {
    fakeLlm?.server?.close();
    if (scenario?.cleanup) scenario.cleanup(setup);
  }
}
