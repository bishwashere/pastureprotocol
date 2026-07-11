#!/usr/bin/env node

import assert from 'assert';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';

import {
  CodexAppServerClient,
  CodexChatGptAuth,
  getPastureCodexHome,
} from '../../../../lib/llm/codex-app-server.js';

const testCodexHome = mkdtempSync(join(tmpdir(), 'pasture-isolated-codex-home-'));

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error(message);
}

function createFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killSignal = null;
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.killSignal = signal;
    queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  };
  return child;
}

function captureJsonLines(stream, onMessage = () => {}) {
  const messages = [];
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        messages.push(message);
        onMessage(message);
      }
      newline = buffer.indexOf('\n');
    }
  });
  return messages;
}

function sendJsonLine(stream, message, splitAt = 0) {
  const line = `${JSON.stringify(message)}\n`;
  if (splitAt > 0 && splitAt < line.length) {
    stream.write(line.slice(0, splitAt));
    queueMicrotask(() => stream.write(line.slice(splitAt)));
    return;
  }
  stream.write(line);
}

async function testBundledCodexResolver() {
  const dir = mkdtempSync(join(tmpdir(), 'pasture-codex-entry-'));
  const entry = join(dir, 'codex.js');
  const previous = process.env.PASTURE_CODEX_BUNDLED_ENTRY;
  try {
    writeFileSync(entry, '', 'utf8');
    process.env.PASTURE_CODEX_BUNDLED_ENTRY = entry;
    const inheritedEnv = {
      ...process.env,
      Codex_Home: join(dir, 'normal-codex-home'),
      codex_access_token: 'must-not-leak',
      CODEX_SQLITE_HOME: join(dir, 'normal-sqlite-home'),
      OPENAI_API_KEY: 'must-not-leak',
    };
    const isolatedHome = join(dir, 'pasture-codex-home');
    const client = new CodexAppServerClient({ env: inheritedEnv, codexHome: isolatedHome });
    assert.strictEqual(client.command, process.execPath);
    assert.deepStrictEqual(client.args.slice(0, 3), [entry, 'app-server', '--stdio']);
    assert(client.args.includes('cli_auth_credentials_store="file"'));
    assert(client.args.includes('forced_login_method="chatgpt"'));
    assert(client.args.includes(`sqlite_home=${JSON.stringify(isolatedHome)}`));
    assert.strictEqual(client.codexHome, isolatedHome);
    assert.strictEqual(client.env.CODEX_HOME, isolatedHome);
    assert.strictEqual(client.env.CODEX_SQLITE_HOME, isolatedHome);
    assert.strictEqual(Object.hasOwn(client.env, 'Codex_Home'), false);
    assert.strictEqual(Object.hasOwn(client.env, 'codex_access_token'), false);
    assert.strictEqual(Object.hasOwn(client.env, 'OPENAI_API_KEY'), false);
    assert.strictEqual(client.cwd, isolatedHome);
    assert.strictEqual(inheritedEnv.Codex_Home, join(dir, 'normal-codex-home'));
    await client.close();
  } finally {
    if (previous === undefined) delete process.env.PASTURE_CODEX_BUNDLED_ENTRY;
    else process.env.PASTURE_CODEX_BUNDLED_ENTRY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testJsonlClient() {
  const child = createFakeChild();
  let spawnCall = null;
  const spawnImpl = (command, args, options) => {
    spawnCall = { command, args, options };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };

  const outbound = captureJsonLines(child.stdin, (message) => {
    if (message.method === 'initialize') {
      sendJsonLine(child.stdout, {
        id: message.id,
        result: { userAgent: 'codex-test', platformFamily: 'unix', platformOs: 'linux' },
      }, 17);
    }
  });

  const client = new CodexAppServerClient({
    command: 'fake-codex',
    spawnImpl,
    requestTimeoutMs: 100,
    codexHome: testCodexHome,
  });
  const notifications = [];
  const serverRequests = [];
  const clientErrors = [];
  const transportErrors = [];
  client.on('notification', (message) => notifications.push(message));
  client.on('serverRequest', (message) => serverRequests.push(message));
  client.on('clientError', (error) => clientErrors.push(error));
  client.on('transportError', (error) => transportErrors.push(error));

  await client.start();

  assert.strictEqual(spawnCall.command, 'fake-codex');
  assert(spawnCall.args.includes('app-server'), 'client should spawn `codex app-server`');
  assert(spawnCall.args.includes('--stdio'), 'client should use the stdio transport');
  assert.deepStrictEqual(spawnCall.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.strictEqual(spawnCall.options.env.CODEX_HOME, testCodexHome);
  assert.strictEqual(spawnCall.options.env.CODEX_SQLITE_HOME, testCodexHome);
  assert.strictEqual(spawnCall.options.cwd, testCodexHome);
  assert.strictEqual(outbound[0].method, 'initialize');
  assert.strictEqual(outbound[0].params.clientInfo.name, 'pasture_protocol');
  assert.strictEqual(outbound[0].params.capabilities.experimentalApi, true);
  assert.strictEqual(outbound[1].method, 'initialized');
  assert(!Object.hasOwn(outbound[1], 'id'), 'initialized must be a notification');

  const firstPromise = client.request('test/first', { value: 1 });
  const secondPromise = client.request('test/second', { value: 2 });
  await waitFor(
    () => outbound.some((message) => message.method === 'test/second'),
    'client did not write both requests',
  );
  const first = outbound.find((message) => message.method === 'test/first');
  const second = outbound.find((message) => message.method === 'test/second');

  child.stdout.write(`${JSON.stringify({ id: second.id, result: { order: 2 } })}\n`);
  sendJsonLine(child.stdout, { id: first.id, result: { order: 1 } }, 9);
  assert.deepStrictEqual(await secondPromise, { order: 2 });
  assert.deepStrictEqual(await firstPromise, { order: 1 });

  sendJsonLine(child.stdout, {
    method: 'account/updated',
    params: { authMode: 'chatgpt', planType: 'plus' },
  }, 13);
  await waitFor(() => notifications.length === 1, 'client did not emit notification');
  assert.deepStrictEqual(notifications[0], {
    method: 'account/updated',
    params: { authMode: 'chatgpt', planType: 'plus' },
  });

  sendJsonLine(child.stdout, {
    id: 'server-request-1',
    method: 'item/tool/call',
    params: { threadId: 'thread-1', tool: 'fixture_tool', arguments: { value: 3 } },
  }, 11);
  await waitFor(() => serverRequests.length === 1, 'client did not emit server request');
  assert.strictEqual(serverRequests[0].method, 'item/tool/call');
  serverRequests[0].respond({ success: true, contentItems: [] });
  await waitFor(
    () => outbound.some((message) => message.id === 'server-request-1'),
    'client did not respond to server request',
  );
  assert.deepStrictEqual(
    outbound.find((message) => message.id === 'server-request-1').result,
    { success: true, contentItems: [] },
  );
  sendJsonLine(child.stdout, {
    id: 'server-request-2',
    method: 'item/tool/call',
    params: { threadId: 'thread-1', tool: 'blocked_tool', arguments: {} },
  });
  await waitFor(() => serverRequests.length === 2, 'client did not emit second server request');
  serverRequests[1].respondError({ code: -32001, message: 'fixture denied' });
  await waitFor(
    () => outbound.some((message) => message.id === 'server-request-2'),
    'client did not reject server request',
  );
  assert.deepStrictEqual(
    outbound.find((message) => message.id === 'server-request-2').error,
    { code: -32001, message: 'fixture denied' },
  );

  const errorPromise = client.request('test/error');
  await waitFor(
    () => outbound.some((message) => message.method === 'test/error'),
    'client did not write error fixture request',
  );
  const errorRequest = outbound.find((message) => message.method === 'test/error');
  sendJsonLine(child.stdout, {
    id: errorRequest.id,
    error: { code: -32000, message: 'fixture RPC failure', data: { retryable: false } },
  });
  await assert.rejects(errorPromise, /fixture RPC failure/);

  await assert.rejects(
    client.request('test/timeout', {}, { timeoutMs: 10 }),
    /timed out/i,
  );
  assert.deepStrictEqual(clientErrors, [], 'valid fragmented JSONL must not emit client errors');

  await client.close();
  assert.strictEqual(child.killed, true);
  assert.deepStrictEqual(transportErrors, [], 'explicit close must not emit a transport error');
}

async function testClientRestartsAfterExit() {
  const children = [createFakeChild(), createFakeChild()];
  const outboundByChild = new Map();
  let spawnCount = 0;
  const spawnImpl = () => {
    const child = children[spawnCount];
    spawnCount += 1;
    const outbound = captureJsonLines(child.stdin, (message) => {
      if (message.method === 'initialize') {
        sendJsonLine(child.stdout, { id: message.id, result: { userAgent: 'codex-test' } });
      }
      if (message.method === 'test/recovered') {
        sendJsonLine(child.stdout, { id: message.id, result: { recovered: true } });
      }
    });
    outboundByChild.set(child, outbound);
    return child;
  };

  const client = new CodexAppServerClient({
    command: 'fake-codex',
    spawnImpl,
    requestTimeoutMs: 100,
    codexHome: testCodexHome,
  });
  const exits = [];
  const errors = [];
  const transportErrors = [];
  client.on('exit', (info) => exits.push(info));
  client.on('clientError', (error) => errors.push(error));
  client.on('transportError', (error) => transportErrors.push(error));

  await client.start();
  const interrupted = client.request('test/interrupted');
  await waitFor(
    () => outboundByChild.get(children[0]).some((message) => message.method === 'test/interrupted'),
    'client did not send interrupted request',
  );
  children[0].emit('close', 7, null);
  await assert.rejects(interrupted, /code 7/i);
  assert.deepStrictEqual(exits, [{ code: 7, signal: null }]);
  assert(errors.some((error) => /code 7/i.test(error.message)));
  assert.strictEqual(transportErrors.length, 1);
  assert.match(transportErrors[0].message, /code 7/i);

  assert.deepStrictEqual(await client.request('test/recovered'), { recovered: true });
  assert.strictEqual(spawnCount, 2, 'client should respawn after an unexpected child exit');
  await client.close();
}

async function testInitializationFailureCleansUpChild() {
  const child = createFakeChild();
  const client = new CodexAppServerClient({
    command: 'fake-codex',
    spawnImpl: () => child,
    requestTimeoutMs: 10,
    codexHome: testCodexHome,
  });
  const transportErrors = [];
  client.on('clientError', () => {});
  client.on('transportError', (error) => transportErrors.push(error));

  await assert.rejects(client.start(), /timed out/i);
  assert.strictEqual(child.killed, true, 'failed initialization should terminate the child');
  assert.strictEqual(transportErrors.length, 1);
  assert.match(transportErrors[0].message, /timed out/i);
  await client.close();
}

class FakeAppServerClient extends EventEmitter {
  constructor() {
    super();
    this.startCalls = 0;
    this.calls = [];
    this.nextLogin = 1;
  }

  async start() {
    this.startCalls += 1;
    return this;
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'account/read') {
      return {
        account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' },
        requiresOpenaiAuth: true,
      };
    }
    if (method === 'account/login/start') {
      const loginId = `login-${this.nextLogin}`;
      this.nextLogin += 1;
      return {
        type: 'chatgpt',
        loginId,
        authUrl: `https://chatgpt.com/auth/${loginId}`,
      };
    }
    if (method === 'account/login/cancel') return {};
    throw new Error(`unexpected fake request: ${method}`);
  }
}

async function testInjectableAuthManager() {
  const client = new FakeAppServerClient();
  const auth = new CodexChatGptAuth({
    client,
    loginTtlMs: 5_000,
    terminalTtlMs: 5_000,
  });

  const account = await auth.readAccount({ refreshToken: true });
  assert.strictEqual(account.account.type, 'chatgpt');
  assert.deepStrictEqual(client.calls.at(-1), {
    method: 'account/read',
    params: { refreshToken: true },
  });

  const login = await auth.startLogin();
  assert.strictEqual(login.id, 'login-1');
  assert.strictEqual(login.url, 'https://chatgpt.com/auth/login-1');
  assert.strictEqual(login.status, 'pending');
  assert.strictEqual(login.error, null);
  assert(Number.isFinite(login.createdAt));
  assert(login.expiresAt > login.createdAt);
  assert.deepStrictEqual(client.calls.at(-1), {
    method: 'account/login/start',
    // The App Server's default local success page completes inside the popup.
    // Hosted branded pages can attempt a codex:// desktop deep link on Linux.
    params: { type: 'chatgpt' },
  });
  assert.strictEqual(auth.getLoginStatus(login.id).status, 'pending');

  client.emit('notification', {
    method: 'account/login/completed',
    params: { loginId: login.id, success: true, error: null },
  });
  const completed = auth.getLoginStatus(login.id);
  assert.strictEqual(completed.status, 'complete');
  assert.strictEqual(completed.error, null);
  assert(Number.isFinite(completed.completedAt));

  const failedLogin = await auth.startLogin();
  client.emit('notification', {
    method: 'account/login/completed',
    params: { loginId: failedLogin.id, success: false, error: 'User denied access' },
  });
  const failed = auth.getLoginStatus(failedLogin.id);
  assert.strictEqual(failed.status, 'error');
  assert.strictEqual(failed.error, 'User denied access');
  assert(Number.isFinite(failed.completedAt));

  const cancelledLogin = await auth.startLogin();
  await auth.cancelLogin(cancelledLogin.id);
  assert.deepStrictEqual(client.calls.at(-1), {
    method: 'account/login/cancel',
    params: { loginId: cancelledLogin.id },
  });
  const cancelled = auth.getLoginStatus(cancelledLogin.id);
  assert.strictEqual(cancelled.status, 'error');
  assert.match(cancelled.error, /cancel/i);
  assert(Number.isFinite(cancelled.completedAt));

  assert.strictEqual(client.listenerCount('notification'), 1);
  auth.dispose();
  assert.strictEqual(client.listenerCount('notification'), 0);
}

await testBundledCodexResolver();
await testJsonlClient();
await testClientRestartsAfterExit();
await testInitializationFailureCleansUpChild();
await testInjectableAuthManager();

const previousStateDir = process.env.PASTURE_STATE_DIR;
process.env.PASTURE_STATE_DIR = join(testCodexHome, 'state');
assert.strictEqual(getPastureCodexHome(), join(testCodexHome, 'state', 'codex'));
if (previousStateDir === undefined) delete process.env.PASTURE_STATE_DIR;
else process.env.PASTURE_STATE_DIR = previousStateDir;
rmSync(testCodexHome, { recursive: true, force: true });

console.log('test-codex-app-server-auth passed');
