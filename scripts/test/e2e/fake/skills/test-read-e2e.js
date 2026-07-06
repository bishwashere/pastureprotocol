#!/usr/bin/env node
/**
 * Fake-lane E2E for read:
 * user message -> index.js --test -> fake LLM planner/tool loop -> real read skill -> reply.
 */

import { createServer } from 'http';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const TIMEOUT_MS = 60_000;
const USER_MESSAGE = 'Show me what is inside workspace/config.json.';
const FIXTURE_TEXT = [
  '{',
  '  "project": "read-fake-e2e",',
  '  "purpose": "prove fake read E2E uses the real read tool"',
  '}',
].join('\n');

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
    skills: ['read'],
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
    plan: 'Use read_file to inspect workspace/config.json, then summarize the file content.',
    answer_style: 'short',
    reason: 'The user asked to inspect a local workspace file.',
  };
}

function latestToolText(messages) {
  const toolMessages = messages.filter((m) => m.role === 'tool').map((m) => String(m.content || ''));
  return toolMessages[toolMessages.length - 1] || '';
}

function startFakeLlmServer() {
  const calls = [];
  const toolResults = [];
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
        reason: 'Standalone file read is not continuing an active task frame.',
      }) } }] });
      return;
    }

    if (promptText.includes('Work-Mode Classifier') || promptText.includes('Work Mode Classifier') || promptText.includes('work-mode')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"toggle":"no_change","reason":"file inspection request"}' } }] });
      return;
    }

    if (promptText.includes('Task Frame Status')) {
      jsonResponse(res, { choices: [{ message: { role: 'assistant', content: '{"status":"continue","confidence":0.8,"reason":"Read test completed one file inspection."}' } }] });
      return;
    }

    if (hasTools && !hasToolResult) {
      jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_read_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'config.json', from: 1, lines: 20 }),
              },
            }],
          },
        }],
      });
      return;
    }

    const toolText = latestToolText(messages);
    if (toolText) toolResults.push(toolText.split('\n\n---\n')[0]);
    let project = 'unknown';
    let purpose = 'unknown';
    try {
      const result = JSON.parse(toolText.split('\n\n---\n')[0]);
      const parsedFile = JSON.parse(result.text || '{}');
      project = parsedFile.project || project;
      purpose = parsedFile.purpose || purpose;
    } catch {}

    jsonResponse(res, {
      choices: [{
        message: {
          role: 'assistant',
          content: `workspace/config.json has project "${project}" and purpose "${purpose}".`,
        },
      }],
    });
  });
  return listen(server).then((port) => ({ server, port, calls, toolResults }));
}

function createStateDir(fakeLlmPort) {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-read-fake-e2e-'));
  const workspaceDir = join(stateDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, 'config.json'), FIXTURE_TEXT, 'utf8');
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    llm: {
      models: [{
        provider: 'lmstudio',
        baseUrl: `http://127.0.0.1:${fakeLlmPort}/v1`,
        model: 'fake-read-e2e',
        apiKey: 'not-needed',
      }],
      localRpm: 999,
      maxTokens: 1000,
    },
    skills: {
      enabled: ['read'],
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
      resolve({ reply, skillsCalled, stdout });
    });
  });
}

async function main() {
  const fakeLlm = await startFakeLlmServer();
  const stateDir = createStateDir(fakeLlm.port);
  try {
    const { reply, skillsCalled, stdout } = await runChat(USER_MESSAGE, stateDir);
    assert(skillsCalled.includes('read'), `expected read skill, got [${skillsCalled.join(', ')}]. stdout tail: ${stdout.slice(-1200)}`);
    const toolResult = JSON.parse(fakeLlm.toolResults[0] || '{}');
    assert(toolResult.path === 'config.json', `read tool read unexpected path: ${fakeLlm.toolResults[0] || '(none)'}`);
    assert(toolResult.text && toolResult.text.includes('"project": "read-fake-e2e"'), `read tool result did not contain fixture text: ${fakeLlm.toolResults[0] || '(none)'}`);
    assert(toolResult.verification?.verified === true && toolResult.verification?.method === 'read_file', `read tool result did not include read verification: ${fakeLlm.toolResults[0] || '(none)'}`);
    assert(/read-fake-e2e/i.test(reply), `expected fixture project in reply, got: ${reply}`);
    assert(/real read tool/i.test(reply), `expected fixture purpose in reply, got: ${reply}`);
    console.log('verified read tool result: config.json contained project "read-fake-e2e"');
    console.log('read fake E2E passed');
  } finally {
    fakeLlm.server.close();
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
