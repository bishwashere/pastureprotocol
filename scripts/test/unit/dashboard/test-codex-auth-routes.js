#!/usr/bin/env node

import assert from 'assert';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..');

function pickPort() {
  return 22000 + Math.floor(Math.random() * 2000);
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(message);
}

function fakeCodexSource() {
  return `#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { createInterface } from 'readline';

let loggedIn = false;
let nextLogin = 1;
const marker = process.env.FAKE_CODEX_EXIT_MARKER || '';
const codexHomeMarker = process.env.FAKE_CODEX_HOME_MARKER || '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const markExit = () => {
  if (!marker) return;
  try { writeFileSync(marker, 'closed', 'utf8'); } catch (_) {}
};

if (codexHomeMarker) {
  try { writeFileSync(codexHomeMarker, process.env.CODEX_HOME || '', 'utf8'); } catch (_) {}
}

process.on('SIGTERM', () => {
  markExit();
  process.exit(0);
});
process.on('exit', markExit);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'linux' } });
    return;
  }
  if (message.method === 'account/read') {
    send({
      id: message.id,
      result: {
        account: loggedIn ? { type: 'chatgpt', email: 'person@example.test', planType: 'plus' } : null,
        requiresOpenaiAuth: true,
      },
    });
    return;
  }
  if (message.method === 'account/login/start') {
    if (JSON.stringify(message.params) !== JSON.stringify({ type: 'chatgpt' })) {
      send({ id: message.id, error: { code: -32602, message: 'expected local ChatGPT browser login params' } });
      return;
    }
    const loginId = nextLogin === 1 ? 'login-route-test' : 'login-cancel-test';
    const completionDelayMs = nextLogin === 1 ? 25 : 5_000;
    nextLogin += 1;
    send({
      id: message.id,
      result: {
        type: 'chatgpt',
        loginId,
        authUrl: 'https://chatgpt.com/fake-login/' + loginId,
      },
    });
    setTimeout(() => {
      loggedIn = true;
      send({
        method: 'account/login/completed',
        params: { loginId, success: true, error: null },
      });
      send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
    }, completionDelayMs);
    return;
  }
  if (message.method === 'account/login/cancel') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id != null) {
    send({ id: message.id, error: { code: -32601, message: 'unsupported fake method' } });
  }
});
`;
}

const stateDir = mkdtempSync(join(tmpdir(), 'pasture-codex-auth-routes-'));
const port = pickPort();
const baseUrl = `http://127.0.0.1:${port}`;
const fakeCodex = join(stateDir, 'fake-codex.js');
const exitMarker = join(stateDir, 'fake-codex-closed');
const codexHomeMarker = join(stateDir, 'fake-codex-home');
let dashboard = null;
let stderr = '';

try {
  writeFileSync(fakeCodex, fakeCodexSource(), { encoding: 'utf8', mode: 0o755 });
  chmodSync(fakeCodex, 0o755);
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    llm: {
      models: [
        { provider: 'openai', model: 'gpt-test', auth: { type: 'chatgpt' } },
      ],
    },
  }, null, 2), 'utf8');

  dashboard = spawn(process.execPath, ['dashboard/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PASTURE_STATE_DIR: stateDir,
      PASTURE_DASHBOARD_HOST: '127.0.0.1',
      PASTURE_DASHBOARD_PORT: String(port),
      PASTURE_CODEX_COMMAND: fakeCodex,
      PASTURE_CODEX_BUNDLED_ENTRY: join(stateDir, 'no-bundled-codex.js'),
      FAKE_CODEX_EXIT_MARKER: exitMarker,
      FAKE_CODEX_HOME_MARKER: codexHomeMarker,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dashboard.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    return response.ok;
  }, 'dashboard did not start');

  const signedOutResponse = await fetch(`${baseUrl}/api/llm-auth/status`);
  assert.strictEqual(signedOutResponse.status, 200);
  const signedOut = await signedOutResponse.json();
  assert.strictEqual(signedOut.models[0].auth.type, 'chatgpt');
  assert.strictEqual(signedOut.models[0].auth.configured, false);
  assert.strictEqual(signedOut.models[0].auth.managed, 'codex');
  await waitFor(() => existsSync(codexHomeMarker), 'fake Codex child did not report CODEX_HOME');
  const isolatedCodexHome = join(stateDir, 'codex');
  assert.strictEqual(readFileSync(codexHomeMarker, 'utf8'), isolatedCodexHome);
  assert.strictEqual(existsSync(isolatedCodexHome), true);
  if (process.platform !== 'win32') {
    assert.strictEqual(statSync(isolatedCodexHome).mode & 0o777, 0o700);
  }

  const loginResponse = await fetch(`${baseUrl}/api/llm-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelIndex: 0 }),
  });
  assert.strictEqual(loginResponse.status, 200);
  assert.deepStrictEqual(await loginResponse.json(), {
    method: 'chatgpt',
    id: 'login-route-test',
    url: 'https://chatgpt.com/fake-login/login-route-test',
  });

  const completed = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/llm-auth/chatgpt/login-route-test`);
    if (!response.ok) return null;
    const status = await response.json();
    return status.status === 'complete' ? status : null;
  }, 'ChatGPT login did not complete');
  assert.strictEqual(completed.error, null);

  const signedIn = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/llm-auth/status`);
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.models?.[0]?.auth?.configured ? payload : null;
  }, 'dashboard did not report the Codex account');
  assert.strictEqual(signedIn.models[0].auth.account.type, 'chatgpt');
  assert.strictEqual(signedIn.models[0].auth.account.planType, 'plus');
  assert.strictEqual(Object.hasOwn(signedIn.models[0].auth.account, 'email'), false);

  const secondLoginResponse = await fetch(`${baseUrl}/api/llm-auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelIndex: 0 }),
  });
  assert.strictEqual(secondLoginResponse.status, 200);
  const secondLogin = await secondLoginResponse.json();
  assert.strictEqual(secondLogin.id, 'login-cancel-test');

  const cancelResponse = await fetch(`${baseUrl}/api/llm-auth/chatgpt/${secondLogin.id}`, {
    method: 'DELETE',
  });
  assert.strictEqual(cancelResponse.status, 200);
  const cancelled = await cancelResponse.json();
  assert.strictEqual(cancelled.status, 'error');
  assert.match(cancelled.error, /cancel/i);

  const unknownCancel = await fetch(`${baseUrl}/api/llm-auth/chatgpt/unknown-login`, {
    method: 'DELETE',
  });
  assert.strictEqual(unknownCancel.status, 404);

  dashboard.kill('SIGTERM');
  await waitFor(() => dashboard.exitCode !== null, 'dashboard did not stop');
  await waitFor(() => existsSync(exitMarker), 'dashboard did not close the Codex App Server child');
  dashboard = null;

  console.log('test-codex-auth-routes passed');
} catch (error) {
  if (stderr.trim()) console.error(stderr.slice(-2_000));
  throw error;
} finally {
  if (dashboard && dashboard.exitCode === null) {
    dashboard.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (dashboard.exitCode === null) dashboard.kill('SIGKILL');
  }
  rmSync(stateDir, { recursive: true, force: true });
}
