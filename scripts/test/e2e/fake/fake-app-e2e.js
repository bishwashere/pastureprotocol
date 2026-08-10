#!/usr/bin/env node
import { createServer } from 'http';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
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
  const hasToolPlan = Boolean(scenario.toolCall || (Array.isArray(scenario.toolSteps) && scenario.toolSteps.length));
  return {
    workModeToggle: scenario.workModeToggle || 'no_change',
    needsMultiAgent: false,
    needsDurability: false,
    needsWorklog: scenario.needsWorklog === true,
    needsDelegation: false,
    teamRouting: 'none',
    delegationAction: 'none',
    targetAgentId: '',
    mode: scenario.mode || (hasToolPlan ? 'tool' : 'chat'),
    skills: scenario.skills || [],
    requiredToolSteps: scenario.requiredToolSteps || [],
    executionMode: hasToolPlan ? 'tool_use' : 'direct_answer',
    usesExistingWorkIntake: false,
    mustUseTool: scenario.mustUseTool === true || hasToolPlan,
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
    needsWorklog: false,
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
  const toolText = stripToolDoc(latestToolText(messages));
  if (toolText) scenario.toolResults.push(toolText);
  if (typeof scenario.finalReply === 'function') {
    return scenario.finalReply(toolText, messages);
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
  const requests = [];
  const states = [
    {
      entity_id: 'light.fake_living_room',
      state: 'off',
      attributes: { friendly_name: 'Fake Living Room Light' },
    },
    {
      entity_id: 'sensor.fake_temperature',
      state: '72',
      attributes: { friendly_name: 'Fake Temperature', unit_of_measurement: 'F' },
    },
  ];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/api/states') return jsonResponse(res, states);
    if (req.url === '/api/states/light.fake_living_room') return jsonResponse(res, states[0]);
    if (req.method === 'POST' && req.url === '/api/services/light/turn_on') {
      const body = await readJson(req);
      requests[requests.length - 1].body = body;
      if (body?.entity_id === 'light.fake_living_room') states[0].state = 'on';
      return jsonResponse(res, [{ ...states[0] }]);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, states, requests };
}

async function startFakeLlmServer(scenario) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const body = await readJson(req);
    scenario.llmRequests.push(body);
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
    if (promptText.includes('# Tool Result Checkpoint')) {
      if (Number(scenario.checkpointFailuresRemaining || 0) > 0) {
        scenario.checkpointFailuresRemaining -= 1;
        return jsonResponse(res, {
          choices: [{ message: { role: 'assistant', content: 'transient malformed checkpoint' } }],
        });
      }
      const checkpointInput = [...messages].reverse().find((m) => m?.role === 'user');
      let latestToolResults = '';
      try {
        const parsed = JSON.parse(String(checkpointInput?.content || '{}'));
        latestToolResults = JSON.stringify(parsed?.latestToolResults || []);
      } catch (_) {}
      const facts = [...new Set(latestToolResults.match(/PROJECT_[A-Z0-9]+_STATUS=[A-Z_]+/g) || [])];
      return jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: JSON.stringify({
              save: facts.length > 0,
              summary: facts.length ? `Captured ${facts.length} project status result(s).` : '',
              completed: facts.map((fact) => `Checked ${fact.split('_STATUS=')[0]}`),
              facts,
              evidence: facts.map((fact) => `Tool returned ${fact}`),
              failures: [],
              nextSteps: [],
              supersedes: [],
            }),
          },
        }],
      });
    }
    if (promptText.includes('Casual') || promptText.includes('casual')) {
      return jsonResponse(res, { choices: [{ message: { role: 'assistant', content: scenario.finalReply || 'Hi. How can I help?' } }] });
    }
    const assistantDecisionCount = messages.filter((m) => (
      m?.role === 'assistant'
      && ((Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || String(m.content || '').trim())
    )).length;
    const lastAssistantToolName = [...messages]
      .reverse()
      .find((m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length)
      ?.tool_calls?.[0]?.function?.name || '';
    if (
      hasTools
      && promptText.includes('# Required Worklog Step')
      && lastAssistantToolName !== 'worklog_read'
    ) {
      return jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_fake_worklog_read',
              type: 'function',
              function: { name: 'worklog_read', arguments: '{}' },
            }],
          },
        }],
      });
    }
    const plannedStep = Array.isArray(scenario.toolSteps)
      ? scenario.toolSteps[assistantDecisionCount]
      : (!hasToolResult ? scenario.toolCall : null);
    if (hasTools && plannedStep) {
      if (typeof scenario.inspectToolStepRequest === 'function') {
        scenario.inspectToolStepRequest({ plannedStep, assistantDecisionCount, messages, body });
      }
      if (typeof plannedStep.content === 'string') {
        return jsonResponse(res, {
          choices: [{ message: { role: 'assistant', content: plannedStep.content } }],
        });
      }
      return jsonResponse(res, {
        choices: [{
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: `call_fake_${assistantDecisionCount + 1}`,
              type: 'function',
              function: {
                name: plannedStep.name,
                arguments: JSON.stringify(plannedStep.arguments || {}),
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

function runChat(message, stateDir, extraEnv = {}, sanitizeEnv = false) {
  return new Promise((resolve, reject) => {
    const inheritedEnv = sanitizeEnv
      ? {
          HOME: process.env.HOME || '',
          PATH: process.env.PATH || '',
          LANG: process.env.LANG || 'C.UTF-8',
          TMPDIR: process.env.TMPDIR || '',
        }
      : process.env;
    const child = spawn('node', ['index.js', '--test', message], {
      cwd: ROOT,
      env: {
        ...inheritedEnv,
        ...extraEnv,
        PASTURE_STATE_DIR: stateDir,
        PASTURE_INSTALL_DIR: ROOT,
        PASTURE_DAEMON_LOG_PATH: join(stateDir, 'daemon.log'),
      },
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
  const longTaskStatuses = ['HEALTHY', 'DEGRADED', 'OFFLINE', 'MAINTENANCE'];
  const longTaskFacts = Array.from({ length: 36 }, (_, index) => (
    `PROJECT_${String(index + 1).padStart(2, '0')}_STATUS=${longTaskStatuses[index % longTaskStatuses.length]}`
  ));
  const longTaskFiles = Object.fromEntries(longTaskFacts.map((fact, index) => {
    const projectId = String(index + 1).padStart(2, '0');
    const filler = String.fromCharCode(65 + index).repeat(12_000);
    // Alternate head/tail placement so the checkpoint path proves it retains
    // both ends of large results.
    return [`project-${projectId}.txt`, index % 2 === 0 ? `${filler}\n${fact}` : `${fact}\n${filler}`];
  }));
  const longTaskSteps = longTaskFacts.map((_fact, index) => ({
    name: 'read_file',
    arguments: { path: `project-${String(index + 1).padStart(2, '0')}.txt` },
  }));
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
      assert: ({ reply, skillsCalled }, { stateDir, toolResults }) => {
        assert(skillsCalled.includes('write'), 'write skill was not called');
        assert(/note\.txt/.test(reply), 'reply did not mention note.txt');
        const writtenPath = join(stateDir, 'workspace', 'note.txt');
        assert(existsSync(writtenPath), `write did not create ${writtenPath}`);
        assert(readFileSync(writtenPath, 'utf8') === 'fake write e2e', 'write created note.txt with unexpected content');
        const parsed = JSON.parse(toolResults[0] || '{}');
        assert(parsed.written === true && parsed.path === 'note.txt', `write tool result did not confirm write: ${toolResults[0] || '(none)'}`);
        assert(parsed.verification?.verified === true && parsed.verification?.method === 'read_after_write', `write tool result did not include read-after-write verification: ${toolResults[0] || '(none)'}`);
        console.log('verified write side effect: workspace/note.txt contains "fake write e2e"');
      },
    },
    'edit-e2e': {
      name: 'edit-e2e',
      message: 'Edit the fixture file.',
      skills: ['edit'],
      files: { 'edit.txt': 'color=red\n' },
      toolCall: { name: 'edit_file', arguments: { path: 'edit.txt', oldString: 'red', newString: 'blue' } },
      finalReply: 'Edited edit.txt from red to blue.',
      assert: ({ reply, skillsCalled }, { stateDir, toolResults }) => {
        assert(skillsCalled.includes('edit'), 'edit skill was not called');
        assert(reply.includes('edit.txt'), 'reply did not mention edit.txt');
        const editedPath = join(stateDir, 'workspace', 'edit.txt');
        assert(readFileSync(editedPath, 'utf8') === 'color=blue\n', 'edit.txt content was not changed to blue');
        const parsed = JSON.parse(toolResults[0] || '{}');
        assert(parsed.replaced === true && parsed.count === 1, `edit tool result did not confirm replacement: ${toolResults[0] || '(none)'}`);
        assert(parsed.verification?.verified === true && parsed.verification?.method === 'read_after_write', `edit tool result did not include read-after-write verification: ${toolResults[0] || '(none)'}`);
        console.log('verified edit side effect: workspace/edit.txt contains "color=blue"');
      },
    },
    'apply-patch-e2e': {
      name: 'apply-patch-e2e',
      message: 'Apply the fixture patch.',
      skills: ['apply-patch'],
      files: { 'patch.txt': 'one\ntwo\nthree' },
      toolCall: { name: 'apply_patch_apply', arguments: { path: 'patch.txt', hunk: ' one\n-two\n+TWO\n three' } },
      finalReply: 'Applied the patch to patch.txt.',
      assert: ({ reply, skillsCalled }, { stateDir, toolResults }) => {
        assert(skillsCalled.includes('apply-patch'), 'apply-patch skill was not called');
        assert(reply.includes('patch.txt'), 'reply did not mention patch.txt');
        const patchedPath = join(stateDir, 'workspace', 'patch.txt');
        assert(readFileSync(patchedPath, 'utf8') === 'one\nTWO\nthree', 'patch.txt content was not patched');
        const parsed = JSON.parse(toolResults[0] || '{}');
        assert(parsed.applied === true && parsed.path === 'patch.txt', `patch tool result did not confirm apply: ${toolResults[0] || '(none)'}`);
        assert(parsed.verification?.verified === true && parsed.verification?.method === 'read_after_write', `patch tool result did not include read-after-write verification: ${toolResults[0] || '(none)'}`);
        console.log('verified apply-patch side effect: workspace/patch.txt contains "TWO"');
      },
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
    'write-exec-fork-e2e': {
      name: 'write-exec-fork-e2e',
      mode: 'code',
      message: 'Create a small JavaScript runtime probe, run it with Node, recover if it fails, and report the successful output.',
      skills: ['go-read', 'write', 'exec'],
      requiredToolSteps: [
        {
          kind: 'write',
          anyOfSkills: ['write'],
          anyOfTools: ['write_file'],
          requiredArguments: { path: 'runtime-probe.js' },
        },
        {
          kind: 'execute',
          anyOfSkills: ['exec'],
          anyOfTools: ['exec_run'],
          requiredArguments: { command: 'node', argv: ['runtime-probe.js'] },
          resultContains: 'PASTURE_FORK_RUNTIME_OK:',
        },
        {
          kind: 'verify',
          anyOfSkills: ['go-read'],
          anyOfTools: ['go_read_run'],
          requiredArguments: { command: 'cat', argv: ['runtime-probe.js'] },
          resultContains: 'PASTURE_FORK_RUNTIME_OK:',
        },
      ],
      files: { 'evidence.txt': 'READ_EVIDENCE_SENTINEL\n' },
      skillConfig: {
        exec: {
          mode: 'allowlist',
          allowlist: ['node'],
          timeoutMs: 30_000,
        },
      },
      toolSteps: [
        { name: 'go_read_run', arguments: { command: 'ls', argv: ['-1'] } },
        { name: 'go_read_run', arguments: { command: 'cat', argv: ['evidence.txt'] } },
        { content: 'I cannot do this because write and execution tools are unavailable.' },
        {
          name: 'write_file',
          arguments: {
            path: 'fail.js',
            content: "console.error('EXEC_FAILURE_SENTINEL');\nprocess.exit(17);\n",
          },
        },
        { name: 'exec_run', arguments: { command: 'node', argv: ['fail.js'] } },
        {
          name: 'write_file',
          arguments: {
            path: 'runtime-probe.js',
            content: "console.log('PASTURE_FORK_RUNTIME_OK:42');\n",
          },
        },
        { name: 'exec_run', arguments: { command: 'node', argv: ['runtime-probe.js'] } },
        { name: 'go_read_run', arguments: { command: 'cat', argv: ['runtime-probe.js'] } },
      ],
      finalReply: 'PASTURE_FORK_RUNTIME_OK:42',
      sanitizeEnv: true,
      cleanupStateDir: true,
      extraEnv: {
        PASTURE_MAX_TOOL_ROUNDS: '1',
        PASTURE_MAX_TOOL_ROUNDS_WRITE: '10',
        PASTURE_MAX_COMPLETENESS_RETRIES: '0',
      },
      inspectToolStepRequest({ assistantDecisionCount, messages }) {
        if (assistantDecisionCount !== 5) return;
        const transcript = messages.map((m) => String(m.content || '')).join('\n');
        const hasReadEvidence = transcript.includes('READ_EVIDENCE_SENTINEL');
        const hasExecFailure = transcript.includes('EXEC_FAILURE_SENTINEL');
        if (hasReadEvidence && hasExecFailure) {
          this.transcriptContinuityObserved = true;
        }
      },
      assert: ({ reply, skillsCalled, stdout }, { stateDir, scenario, toolResults }) => {
        assert(scenario.transcriptContinuityObserved === true,
          'recovery request lost earlier read or failed-exec evidence');
        assert(skillsCalled.filter((id) => id === 'write').length >= 2,
          `expected both script writes, got [${skillsCalled.join(', ')}]`);
        assert(skillsCalled.filter((id) => id === 'exec').length >= 2,
          `expected failed and successful exec calls, got [${skillsCalled.join(', ')}]`);
        assert(skillsCalled.includes('go-read'), 'verification read was not called');
        assert(reply.includes('PASTURE_FORK_RUNTIME_OK:42'), `successful output missing from reply: ${reply}`);
        assert(!reply.includes('tools are unavailable'), `false unavailable draft escaped as final reply: ${reply}`);
        assert(!stdout.includes('planned_tool_retry') && !stdout.includes('planned_code_write_retry'),
          'runtime restarted the turn through a legacy fresh retry');
        const activityDir = join(stateDir, 'daily-logs', 'team-activity');
        const activityFile = readdirSync(activityDir).find((name) => name.endsWith('.jsonl'));
        const activityRows = readFileSync(join(activityDir, activityFile), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        const turnDone = activityRows.filter((row) => row.type === 'turn_done').at(-1);
        assert(turnDone?.status === 'ok',
          `a recovered failed exec left the successful turn marked ${turnDone?.status || 'unknown'}`);
        const probePath = join(stateDir, 'workspace', 'runtime-probe.js');
        assert(readFileSync(probePath, 'utf8') === "console.log('PASTURE_FORK_RUNTIME_OK:42');\n",
          'runtime probe was not persisted with expected source');
        assert(toolResults.some((text) => text.includes('EXEC_FAILURE_SENTINEL')),
          'failed exec stderr was not retained in the tool transcript');
        assert(toolResults.some((text) => text.includes('PASTURE_FORK_RUNTIME_OK:42')),
          'successful exec output was not retained in the tool transcript');
      },
    },
    'long-task-worklog-e2e': {
      name: 'long-task-worklog-e2e',
      mode: 'research',
      needsWorklog: true,
      checkpointFailuresRemaining: 1,
      message: 'Inspect every project status file and give me one complete status summary.',
      skills: ['read', 'worklog'],
      requiredToolSteps: [{
        kind: 'inspect',
        anyOfSkills: ['read'],
        anyOfTools: ['read_file'],
        requiredArguments: { path: 'project-01.txt' },
        resultContains: 'IMPOSSIBLE_PLANNER_OUTPUT_SENTINEL',
      }],
      files: longTaskFiles,
      toolSteps: longTaskSteps,
      finalReply(_toolText, messages) {
        const transcript = messages.map((m) => String(m.content || '')).join('\n');
        const hasAll = longTaskFacts.every((fact) => transcript.includes(fact));
        const rawWasTruncated = transcript.includes('[earlier tool output truncated to fit context budget');
        if (transcript.includes('IMPOSSIBLE_PLANNER_OUTPUT_SENTINEL')) {
          this.exactContractPromptObserved = true;
        }
        if (hasAll) this.worklogContinuityObserved = true;
        if (rawWasTruncated) this.rawTruncationObserved = true;
        return hasAll ? longTaskFacts.join('\n') : 'MISSING_DURABLE_PROJECT_CONTEXT';
      },
      cleanupStateDir: true,
      extraEnv: {
        PASTURE_MAX_TOOL_ROUNDS: '3',
        PASTURE_MAX_TOOL_ROUNDS_WRITE: '10',
        PASTURE_MAX_TOOL_ROUNDS_WORKLOG: '100',
        PASTURE_MESSAGES_CHAR_BUDGET: '30000',
        PASTURE_MAX_COMPLETENESS_RETRIES: '0',
      },
      assert: ({ reply, skillsCalled, stdout }, { stateDir, scenario }) => {
        assert(skillsCalled.filter((id) => id === 'read').length === longTaskFacts.length,
          `expected ${longTaskFacts.length} project reads, got [${skillsCalled.join(', ')}]`);
        assert(skillsCalled.filter((id) => id === 'read').length > 30,
          'long task did not prove it can exceed the old 30-round limit');
        assert(skillsCalled.includes('worklog'), 'runtime did not make the agent read its durable worklog');
        assert(!reply.includes('IMPOSSIBLE_PLANNER_OUTPUT_SENTINEL') && !reply.includes('Remaining step(s)'),
          `an impossible planner contract blocked the long task: ${reply}`);
        assert(scenario.exactContractPromptObserved !== true,
          'an impossible exact planner contract leaked into the long-task agent prompt');
        assert(scenario.rawTruncationObserved === true || stdout.includes('tool_round_budget_truncate'),
          'test did not force raw tool transcript truncation');
        assert(scenario.worklogContinuityObserved === true,
          'final synthesis did not receive all checkpointed early and late facts');
        for (const fact of longTaskFacts) {
          assert(reply.includes(fact), `final reply forgot ${fact}: ${reply}`);
        }
        const worklogDir = join(stateDir, 'task-worklogs');
        const worklogFiles = readdirSync(worklogDir).filter((name) => name.endsWith('.json'));
        assert(worklogFiles.length === 1, `expected one per-run worklog, got ${worklogFiles.length}`);
        const persisted = JSON.parse(readFileSync(join(worklogDir, worklogFiles[0]), 'utf8'));
        assert(persisted.status === 'completed', `expected completed worklog, got ${persisted.status}`);
        const checkpointFacts = persisted.checkpoints.flatMap((checkpoint) => checkpoint.facts || []);
        for (const fact of longTaskFacts) {
          assert(checkpointFacts.filter((item) => item === fact).length === 1,
            `expected one independent persisted checkpoint for ${fact}`);
        }
        assert(persisted.toolEvents.some((event) => event.skillId === 'worklog' && event.toolName === 'read'),
          'worklog did not record the mandatory final read event');
      },
    },
    'long-task-timeout-e2e': {
      name: 'long-task-timeout-e2e',
      mode: 'research',
      needsWorklog: true,
      message: 'Inspect every project, but stop cleanly if the long-task window ends.',
      skills: ['read', 'worklog'],
      files: { 'project-timeout.txt': 'THIS_TOOL_MUST_NOT_RUN' },
      toolSteps: [{ name: 'read_file', arguments: { path: 'project-timeout.txt' } }],
      finalReply(_toolText, messages) {
        const transcript = messages.map((m) => String(m.content || '')).join('\n');
        this.timeoutPromptObserved = transcript.includes('long-task window has ended');
        return 'The task is unfinished because the long-task window ended. The durable worklog is saved and you can ask me to continue.';
      },
      expectNoToolCalls: true,
      cleanupStateDir: true,
      extraEnv: {
        PASTURE_MAX_LONG_TASK_RUNTIME_MS: '0',
        PASTURE_MAX_COMPLETENESS_RETRIES: '0',
      },
      assert: ({ reply, skillsCalled }, { scenario }) => {
        assert(skillsCalled.length === 0,
          `deadline should stop before tool execution, got [${skillsCalled.join(', ')}]`);
        assert(scenario.timeoutPromptObserved === true,
          'final synthesis did not receive the runtime timeout reason');
        assert(reply.includes('unfinished') && reply.includes('continue'),
          `timeout reply was not useful to the user: ${reply}`);
      },
    },
    'required-steps-unavailable-e2e': {
      name: 'required-steps-unavailable-e2e',
      mode: 'code',
      message: 'Write and run a JavaScript probe.',
      skills: ['write', 'exec'],
      requiredToolSteps: [
        {
          kind: 'write',
          anyOfSkills: ['write'],
          anyOfTools: ['write_file'],
          requiredArguments: { path: 'runtime-probe.js' },
        },
        {
          kind: 'execute',
          anyOfSkills: ['exec'],
          anyOfTools: ['exec_run'],
          requiredArguments: { command: 'node', argv: ['runtime-probe.js'] },
          resultContains: 'PASTURE_FORK_RUNTIME_OK:',
        },
      ],
      skillConfig: {
        exec: { mode: 'allowlist', allowlist: ['node'], timeoutMs: 30_000 },
      },
      toolSteps: Array.from({ length: 4 }, () => ({
        content: 'I cannot do this because write and execution tools are unavailable.',
      })),
      finalReply: 'THIS_FALSE_FINAL_MUST_NOT_ESCAPE',
      expectNoToolCalls: true,
      sanitizeEnv: true,
      cleanupStateDir: true,
      extraEnv: {
        PASTURE_MAX_TOOL_ROUNDS: '1',
        PASTURE_MAX_TOOL_ROUNDS_WRITE: '3',
        PASTURE_MAX_COMPLETENESS_RETRIES: '0',
      },
      assert: ({ reply, skillsCalled }) => {
        assert(skillsCalled.length === 0, `stubborn scenario unexpectedly called skills: ${skillsCalled.join(', ')}`);
        assert(!reply.includes('tools are unavailable'), `false unavailable draft escaped: ${reply}`);
        assert(!reply.includes('THIS_FALSE_FINAL_MUST_NOT_ESCAPE'), `fake synthesis escaped: ${reply}`);
        assert(reply.includes('Remaining step(s): write [write] via [write_file]'),
          `runtime did not surface the unmet structured requirement: ${reply}`);
      },
    },
    'node-script-fork-e2e': {
      name: 'node-script-fork-e2e',
      mode: 'code',
      message: 'Run a one-off JavaScript project diagnostic and report its output.',
      skills: ['exec'],
      requiredToolSteps: [
        {
          kind: 'execute',
          anyOfSkills: ['exec'],
          anyOfTools: ['exec_node_script'],
          requiredArguments: { envFile: '.env' },
          resultContains: 'NODE_SCRIPT_RUNTIME_OK:',
        },
      ],
      files: {
        'unrelated-project/.env': 'PASTURE_NODE_SCRIPT_PROBE=42\n',
      },
      skillConfig: {
        exec: { mode: 'allowlist', allowlist: ['node'], timeoutMs: 30_000 },
      },
      toolSteps: [
        {
          name: 'exec_run',
          arguments: { command: 'node', argv: ['--version'] },
        },
        { content: 'WRONG_ACTION_FALSE_FINAL' },
        {
          name: 'exec_node_script',
          arguments: {
            source: [
              "import { MongoClient } from 'mongodb';",
              "console.log(`NODE_SCRIPT_RUNTIME_OK:${typeof MongoClient}:${process.env.PASTURE_NODE_SCRIPT_PROBE}`);",
            ].join('\n'),
            envFile: '.env',
          },
        },
      ],
      afterStateDir: (stateDir, setup, scenario) => {
        const projectCwd = join(stateDir, 'workspace', 'unrelated-project');
        scenario.toolSteps[2].arguments.cwd = projectCwd;
        scenario.requiredToolSteps[0].requiredArguments.cwd = projectCwd;
      },
      finalReply: 'NODE_SCRIPT_RUNTIME_OK:function:42',
      sanitizeEnv: true,
      cleanupStateDir: true,
      extraEnv: {
        PASTURE_MAX_TOOL_ROUNDS: '1',
        PASTURE_MAX_TOOL_ROUNDS_WRITE: '4',
        PASTURE_MAX_COMPLETENESS_RETRIES: '0',
      },
      assert: ({ reply, skillsCalled }, { toolResults }) => {
        assert(skillsCalled.join(',') === 'exec,exec', `wrong exec action should be followed by the transient action, got [${skillsCalled.join(', ')}]`);
        assert(reply.includes('NODE_SCRIPT_RUNTIME_OK:function:42'), `transient diagnostic output missing: ${reply}`);
        assert(!reply.includes('WRONG_ACTION_FALSE_FINAL'), `wrong-action draft escaped as final reply: ${reply}`);
        assert(toolResults.some((text) => text.includes('NODE_SCRIPT_RUNTIME_OK:function:42')),
          'transient node_script output was not retained in the transcript');
      },
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
      message: 'Turn on my fake living room light.',
      skills: ['home-assistant'],
      toolCall: { name: 'home_assistant_run', arguments: { command: 'on light.fake_living_room' } },
      finalReply: 'Fake Living Room Light was turned on.',
      setup: async () => ({ ha: await startHaServer() }),
      envFromSetup: ({ ha }) => ({ envFile: `HA_URL=${ha.url}\nHA_TOKEN=fake-token\n` }),
      assert: ({ reply, skillsCalled }, { setup, toolResults }) => {
        assert(skillsCalled.includes('home-assistant'), 'home-assistant skill was not called');
        const serviceCall = setup.ha.requests.find((r) => r.method === 'POST' && r.url === '/api/services/light/turn_on');
        assert(serviceCall, `fake HA server did not receive turn_on call. requests=${JSON.stringify(setup.ha.requests)}`);
        assert(serviceCall.body?.entity_id === 'light.fake_living_room', `turn_on targeted wrong entity: ${JSON.stringify(serviceCall.body)}`);
        assert(setup.ha.states[0].state === 'on', `fake HA state did not change to on: ${setup.ha.states[0].state}`);
        assert(/turned on|on/i.test(reply), `reply did not report on state: ${reply}`);
        assert(toolResults.some((text) => text.includes('Called light.turn_on')), `HA tool result missing service confirmation: ${toolResults.join('\n')}`);
        console.log('verified fake HA side effect: POST /api/services/light/turn_on changed light.fake_living_room to on');
      },
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
      afterStateDir: (stateDir, setup, scenario) => {
        setup.pixelPath = join(stateDir, 'workspace', 'pixel.png');
        scenario.toolCall.arguments.path = setup.pixelPath;
      },
      assert: ({ skillsCalled }, { setup, toolResults }) => {
        assert(skillsCalled.includes('vision'), 'vision skill was not called');
        assert(existsSync(setup.pixelPath), `vision fixture missing at ${setup.pixelPath}`);
        assert(!toolResults.some((text) => /Image file not found|error/i.test(text)), `vision tool returned an error: ${toolResults.join('\n')}`);
      },
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
  scenario.toolResults = [];
  scenario.llmRequests = [];
  scenario.transcriptContinuityObserved = false;
  let setup = {};
  let fakeLlm;
  let stateDir = '';
  try {
    if (scenario.setup) setup = await scenario.setup();
    if (scenario.applySetup) scenario.applySetup(scenario, setup);
    if (scenario.envFromSetup) Object.assign(scenario, scenario.envFromSetup(setup));
    fakeLlm = await startFakeLlmServer(scenario);
    stateDir = createStateDir(scenario, fakeLlm.port);
    if (scenario.afterStateDir) scenario.afterStateDir(stateDir, setup, scenario);
    const extraEnv = {
      ...(scenario.extraEnv || {}),
      ...(scenario.extraEnvFromSetup ? scenario.extraEnvFromSetup(setup) : {}),
    };
    const result = await runChat(scenario.message, stateDir, extraEnv, scenario.sanitizeEnv === true);
    const richestToolTranscript = scenario.llmRequests
      .map((request) => (Array.isArray(request?.messages) ? request.messages : []))
      .sort((a, b) => b.filter((m) => m.role === 'tool').length - a.filter((m) => m.role === 'tool').length)[0] || [];
    scenario.toolResults = richestToolTranscript
      .filter((m) => m.role === 'tool')
      .map((m) => stripToolDoc(m.content));
    if ((scenario.toolCall || scenario.toolSteps) && !scenario.expectNoToolCalls) {
      const expectedSkill = (scenario.skills || [])[0];
      assert(
        !expectedSkill || result.skillsCalled.includes(expectedSkill),
        `expected skill ${expectedSkill}, got [${result.skillsCalled.join(', ')}]`
      );
    }
    if (scenario.assert) scenario.assert(result, { stateDir, setup, scenario, toolResults: scenario.toolResults });
    console.log(`${name} fake E2E passed`);
  } finally {
    fakeLlm?.server?.close();
    if (scenario?.cleanup) scenario.cleanup(setup);
    if (scenario?.cleanupStateDir && stateDir) {
      try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
    }
  }
}
