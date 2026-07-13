import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { StringDecoder } from 'string_decoder';
import { fileURLToPath } from 'url';
import { getStateDir } from '../util/paths.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LOGIN_TTL_MS = 10 * 60_000;
const DEFAULT_TERMINAL_TTL_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_LOGIN_RECORDS = 100;
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_CODEX_ENTRY = join(MODULE_DIR, '..', '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const ISOLATED_CODEX_CONFIG_ARGS = [
  '-c', 'cli_auth_credentials_store="file"',
  '-c', 'forced_login_method="chatgpt"',
];
const INHERITED_CODEX_AUTH_ENV = new Set([
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'OPENAI_API_KEY',
]);

/** Private Codex state owned by Pasture, separate from the user's ~/.codex. */
export function getPastureCodexHome() {
  return join(getStateDir(), 'codex');
}

function isolatedCodexEnvironment(baseEnv, codexHome) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    // Environment names are case-insensitive on Windows. Drop credentials and
    // storage redirects that could make the child reuse normal Codex state.
    if (!INHERITED_CODEX_AUTH_ENV.has(key.toUpperCase())) env[key] = value;
  }
  env.CODEX_HOME = codexHome;
  env.CODEX_SQLITE_HOME = codexHome;
  return env;
}

function ensurePrivateCodexHome(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch (_) {}
}

function defaultCodexLaunch() {
  const bundledEntry = String(process.env.PASTURE_CODEX_BUNDLED_ENTRY || '').trim() || BUNDLED_CODEX_ENTRY;
  if (existsSync(bundledEntry)) {
    return { command: process.execPath, argsPrefix: [bundledEntry] };
  }
  const configuredCommand = String(process.env.PASTURE_CODEX_COMMAND || '').trim();
  if (/\.m?js$/i.test(configuredCommand) && existsSync(configuredCommand)) {
    return { command: process.execPath, argsPrefix: [configuredCommand] };
  }
  return {
    command: configuredCommand || 'codex',
    argsPrefix: [],
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function errorMessage(error, fallback = 'Codex App Server error') {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && error.message) return String(error.message);
  if (typeof error === 'string' && error.trim()) return error.trim();
  return fallback;
}

function rpcErrorFromResponse(error, method) {
  const err = new Error(errorMessage(error, `Codex App Server request failed: ${method}`));
  if (error && typeof error === 'object') {
    if (error.code !== undefined) err.code = error.code;
    if (error.data !== undefined) err.data = error.data;
    err.rpcError = error;
  }
  err.method = method;
  return err;
}

function rpcErrorPayload(error) {
  if (error && typeof error === 'object' && !(error instanceof Error) && error.message) {
    return {
      code: Number.isFinite(Number(error.code)) ? Number(error.code) : -32000,
      message: String(error.message),
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return {
    code: Number.isFinite(Number(error?.code)) ? Number(error.code) : -32000,
    message: errorMessage(error),
    ...(error?.data !== undefined ? { data: error.data } : {}),
  };
}

/**
 * Newline-delimited JSON-RPC client for `codex app-server --stdio`.
 *
 * Public requests initialize the connection lazily. The same client can be
 * reused by auth and runtime adapters, and it restarts after an unexpected
 * child exit on the next request.
 */
export class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    const explicitCommand = String(options.command || '').trim();
    const launch = explicitCommand
      ? { command: explicitCommand, argsPrefix: [] }
      : defaultCodexLaunch();
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const initializeTimeoutMs = options.initializeTimeoutMs ?? requestTimeoutMs;
    this.command = launch.command;
    this.codexHome = String(options.codexHome || '').trim() || getPastureCodexHome();
    const appServerArgs = Array.isArray(options.args)
      ? [...options.args]
      : [...launch.argsPrefix, 'app-server', '--stdio'];
    this.args = [
      ...appServerArgs,
      ...ISOLATED_CODEX_CONFIG_ARGS,
      '-c', `sqlite_home=${JSON.stringify(this.codexHome)}`,
    ];
    // Keep project-level .codex configuration out of this infrastructure
    // process. Individual ephemeral model threads receive their own cwd.
    this.cwd = options.cwd ?? this.codexHome;
    this.env = isolatedCodexEnvironment(options.env ?? process.env, this.codexHome);
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.initializeTimeoutMs = positiveNumber(initializeTimeoutMs, this.requestTimeoutMs);
    this.maxLineBytes = positiveNumber(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
    this.clientVersion = String(options.clientVersion || process.env.npm_package_version || '2.0.0');

    this._child = null;
    this._decoder = null;
    this._stdoutBuffer = '';
    this._stderrTail = '';
    this._nextRequestId = 1;
    this._pending = new Map();
    this._startPromise = null;
    this._initialized = false;
    this._closed = false;
  }

  get running() {
    return !!this._child && this._initialized && !this._closed;
  }

  async start() {
    if (this._closed) throw new Error('Codex App Server client is closed.');
    if (this._initialized && this._child) return this;
    if (this._startPromise) return this._startPromise;

    const startPromise = this._startAndInitialize();
    this._startPromise = startPromise;
    try {
      return await startPromise;
    } catch (error) {
      if (this._startPromise === startPromise) this._startPromise = null;
      if (this._child) this._finishChild(this._child, error, null);
      throw error;
    }
  }

  async request(method, params = {}, options = {}) {
    if (typeof method !== 'string' || !method.trim()) {
      throw new Error('Codex App Server request method is required.');
    }
    await this.start();
    const timeoutMs = positiveNumber(options?.timeoutMs, this.requestTimeoutMs);
    return this._requestNow(method, params, timeoutMs);
  }

  notify(method, params = {}) {
    if (typeof method !== 'string' || !method.trim()) {
      throw new Error('Codex App Server notification method is required.');
    }
    this._writeMessage({ method, params: params ?? {} });
  }

  respond(id, result = null) {
    if (id === undefined || id === null) throw new Error('Codex App Server response id is required.');
    this._writeMessage({ id, result });
  }

  respondError(id, error) {
    if (id === undefined || id === null) throw new Error('Codex App Server response id is required.');
    this._writeMessage({ id, error: rpcErrorPayload(error) });
  }

  async close() {
    this._closed = true;
    this._initialized = false;
    this._startPromise = null;
    this._rejectPending(new Error('Codex App Server client closed.'));

    const child = this._child;
    this._child = null;
    this._decoder = null;
    this._stdoutBuffer = '';
    if (!child) return;

    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
    } catch (_) {}
    try {
      if (typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM');
    } catch (_) {}
  }

  async _startAndInitialize() {
    this._spawnChild();
    await this._requestNow('initialize', {
      clientInfo: {
        name: 'pasture_protocol',
        title: 'Pasture Protocol',
        version: this.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, this.initializeTimeoutMs);
    this._writeMessage({ method: 'initialized', params: {} });
    this._initialized = true;
    return this;
  }

  _spawnChild() {
    ensurePrivateCodexHome(this.codexHome);
    let child;
    try {
      child = this.spawnImpl(this.command, this.args, {
        cwd: this.cwd,
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`Could not start Codex App Server: ${errorMessage(error)}`, { cause: error });
    }

    if (!child?.stdin || !child?.stdout || !child?.stderr) {
      try { child?.kill?.('SIGTERM'); } catch (_) {}
      throw new Error('Could not start Codex App Server: child stdio is unavailable.');
    }

    this._child = child;
    this._decoder = new StringDecoder('utf8');
    this._stdoutBuffer = '';
    this._stderrTail = '';

    child.stdout.on('data', (chunk) => this._handleStdout(child, chunk));
    child.stdout.once('end', () => this._flushStdout(child));
    child.stderr.on('data', (chunk) => {
      if (this._child !== child) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this._stderrTail = (this._stderrTail + text).slice(-8_000);
      this.emit('stderr', text);
    });
    child.stdin.on('error', (error) => {
      if (this._child === child) this._finishChild(child, error, null);
    });
    child.once('error', (error) => {
      if (this._child === child) {
        const wrapped = new Error(`Could not run Codex App Server: ${errorMessage(error)}`, { cause: error });
        this._finishChild(child, wrapped, null);
      }
    });
    child.once('close', (code, signal) => {
      if (this._child !== child) return;
      const detail = code === 0
        ? 'Codex App Server exited.'
        : `Codex App Server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}.`;
      const error = new Error(detail);
      this._finishChild(child, error, { code, signal });
    });
  }

  _requestNow(method, params, timeoutMs) {
    const id = this._nextRequestId;
    this._nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(String(id));
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this._pending.set(String(id), { method, resolve, reject, timer });

      try {
        this._writeMessage({ id, method, params: params ?? {} });
      } catch (error) {
        clearTimeout(timer);
        this._pending.delete(String(id));
        reject(error);
      }
    });
  }

  _writeMessage(message) {
    const child = this._child;
    if (!child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('Codex App Server is not running.');
    }
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch (error) {
      throw new Error(`Could not encode Codex App Server message: ${errorMessage(error)}`, { cause: error });
    }
    child.stdin.write(line);
  }

  _handleStdout(child, chunk) {
    if (this._child !== child || !this._decoder) return;
    this._stdoutBuffer += this._decoder.write(chunk);
    if (Buffer.byteLength(this._stdoutBuffer, 'utf8') > this.maxLineBytes && !this._stdoutBuffer.includes('\n')) {
      this._finishChild(child, new Error('Codex App Server sent an oversized JSONL message.'), null);
      return;
    }
    this._drainStdoutLines(child);
  }

  _flushStdout(child) {
    if (this._child !== child || !this._decoder) return;
    this._stdoutBuffer += this._decoder.end();
    this._decoder = null;
    this._drainStdoutLines(child);
    const trailing = this._stdoutBuffer.trim();
    this._stdoutBuffer = '';
    if (trailing) this._handleLine(trailing);
  }

  _drainStdoutLines(child) {
    while (this._child === child) {
      const newline = this._stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this._stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this._stdoutBuffer = this._stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this._finishChild(child, new Error('Codex App Server sent an oversized JSONL message.'), null);
        return;
      }
      if (line.trim()) this._handleLine(line);
    }
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('clientError', new Error(`Invalid JSON from Codex App Server: ${errorMessage(error)}`, { cause: error }));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.emit('clientError', new Error('Invalid message from Codex App Server.'));
      return;
    }

    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && typeof message.method === 'string') {
      const request = {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
        respond: (result) => this.respond(message.id, result),
        respondError: (error) => this.respondError(message.id, error),
      };
      this.emit('serverRequest', request);
      return;
    }

    if (hasId) {
      const pending = this._pending.get(String(message.id));
      if (!pending) {
        this.emit('clientError', new Error(`Unexpected Codex App Server response id: ${message.id}`));
        return;
      }
      clearTimeout(pending.timer);
      this._pending.delete(String(message.id));
      if (message.error !== undefined && message.error !== null) {
        pending.reject(rpcErrorFromResponse(message.error, pending.method));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      this.emit('notification', { method: message.method, params: message.params ?? {} });
      return;
    }
    this.emit('clientError', new Error('Unrecognized message from Codex App Server.'));
  }

  _finishChild(child, error, exitInfo) {
    if (this._child !== child) return;
    this._child = null;
    this._decoder = null;
    this._stdoutBuffer = '';
    this._initialized = false;
    this._startPromise = null;
    this._rejectPending(error);
    if (!exitInfo) {
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
      } catch (_) {}
      try {
        if (typeof child.kill === 'function' && !child.killed) child.kill('SIGTERM');
      } catch (_) {}
    }
    if (exitInfo) this.emit('exit', exitInfo);
    this.emit('transportError', error);
    this.emit('clientError', error);
  }

  _rejectPending(error) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }
}

function publicLoginRecord(record, { includeUrl = false } = {}) {
  if (!record) return null;
  return {
    id: record.id,
    status: record.status,
    error: record.error,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(includeUrl && record.url ? { url: record.url } : {}),
  };
}

/** Managed ChatGPT browser-login state built on a reusable app-server client. */
export class CodexChatGptAuth {
  constructor({
    client,
    loginTtlMs = DEFAULT_LOGIN_TTL_MS,
    terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
    maxLoginRecords = DEFAULT_MAX_LOGIN_RECORDS,
  } = {}) {
    if (!client || typeof client.request !== 'function' || typeof client.on !== 'function') {
      throw new Error('CodexChatGptAuth requires a Codex App Server client.');
    }
    this.client = client;
    this.loginTtlMs = positiveNumber(loginTtlMs, DEFAULT_LOGIN_TTL_MS);
    this.terminalTtlMs = positiveNumber(terminalTtlMs, DEFAULT_TERMINAL_TTL_MS);
    this.maxLoginRecords = Math.max(1, Math.floor(positiveNumber(maxLoginRecords, DEFAULT_MAX_LOGIN_RECORDS)));
    this._logins = new Map();
    this._onNotification = (message) => this._handleNotification(message);
    this.client.on('notification', this._onNotification);
  }

  async readAccount({ refreshToken = false, timeoutMs } = {}) {
    return this.client.request(
      'account/read',
      { refreshToken: !!refreshToken },
      timeoutMs ? { timeoutMs } : {},
    );
  }

  async startLogin() {
    const result = await this.client.request('account/login/start', {
      type: 'chatgpt',
    });
    const id = String(result?.loginId || '').trim();
    const url = String(result?.authUrl || '').trim();
    if (result?.type !== 'chatgpt' || !id || !url) {
      throw new Error('Codex App Server returned an invalid ChatGPT login response.');
    }

    const now = Date.now();
    const existing = this._logins.get(id);
    const record = existing || {
      id,
      status: 'pending',
      error: null,
      createdAt: now,
      expiresAt: now + this.loginTtlMs,
      completedAt: null,
      timer: null,
      url,
    };
    record.url = url;
    if (!existing || existing.status === 'pending') this._schedulePendingExpiry(record);
    this._storeRecord(record);
    return publicLoginRecord(record, { includeUrl: true });
  }

  getLoginStatus(loginId) {
    const id = String(loginId || '').trim();
    if (!id) return null;
    const record = this._logins.get(id);
    if (!record) return null;
    if (record.status === 'pending' && Date.now() >= record.expiresAt) {
      this._markTerminal(record, 'error', 'ChatGPT login expired.');
    }
    return publicLoginRecord(record);
  }

  async cancelLogin(loginId) {
    const id = String(loginId || '').trim();
    if (!id) throw new Error('ChatGPT login id is required.');
    await this.client.request('account/login/cancel', { loginId: id });
    let record = this._logins.get(id);
    if (!record) {
      const now = Date.now();
      record = {
        id,
        status: 'pending',
        error: null,
        createdAt: now,
        expiresAt: now,
        completedAt: null,
        timer: null,
        url: null,
      };
      this._storeRecord(record);
    }
    if (record.status === 'pending') this._markTerminal(record, 'error', 'ChatGPT login cancelled.');
    return publicLoginRecord(record);
  }

  dispose() {
    this.client.off?.('notification', this._onNotification);
    for (const record of this._logins.values()) clearTimeout(record.timer);
    this._logins.clear();
  }

  _handleNotification(message) {
    if (message?.method !== 'account/login/completed') return;
    const id = String(message?.params?.loginId || '').trim();
    if (!id) return;
    let record = this._logins.get(id);
    if (!record) {
      const now = Date.now();
      record = {
        id,
        status: 'pending',
        error: null,
        createdAt: now,
        expiresAt: now + this.loginTtlMs,
        completedAt: null,
        timer: null,
        url: null,
      };
      this._storeRecord(record);
    }
    if (record.status !== 'pending') return;
    if (message.params?.success) {
      this._markTerminal(record, 'complete', null);
    } else {
      this._markTerminal(record, 'error', errorMessage(message.params?.error, 'ChatGPT login failed.'));
    }
  }

  _storeRecord(record) {
    this._logins.set(record.id, record);
    while (this._logins.size > this.maxLoginRecords) {
      const oldestId = this._logins.keys().next().value;
      const oldest = this._logins.get(oldestId);
      clearTimeout(oldest?.timer);
      this._logins.delete(oldestId);
    }
  }

  _schedulePendingExpiry(record) {
    clearTimeout(record.timer);
    const delay = Math.max(1, record.expiresAt - Date.now());
    record.timer = setTimeout(() => {
      if (record.status === 'pending') this._markTerminal(record, 'error', 'ChatGPT login expired.');
    }, delay);
    record.timer.unref?.();
  }

  _markTerminal(record, status, error) {
    clearTimeout(record.timer);
    record.status = status;
    record.error = error;
    record.completedAt = Date.now();
    record.timer = setTimeout(() => {
      if (this._logins.get(record.id) === record) this._logins.delete(record.id);
    }, this.terminalTtlMs);
    record.timer.unref?.();
  }
}

let defaultClient = null;
let defaultAuth = null;

export function getCodexAppServerClient() {
  if (!defaultClient) defaultClient = new CodexAppServerClient();
  return defaultClient;
}

function getDefaultAuth() {
  if (!defaultAuth) defaultAuth = new CodexChatGptAuth({ client: getCodexAppServerClient() });
  return defaultAuth;
}

export function readCodexChatGptAccount(options = {}) {
  return getDefaultAuth().readAccount(options);
}

export function startCodexChatGptLogin() {
  return getDefaultAuth().startLogin();
}

export function getCodexChatGptLoginStatus(loginId) {
  return getDefaultAuth().getLoginStatus(loginId);
}

export function cancelCodexChatGptLogin(loginId) {
  return getDefaultAuth().cancelLogin(loginId);
}

export async function closeCodexAppServerClient() {
  defaultAuth?.dispose();
  defaultAuth = null;
  const client = defaultClient;
  defaultClient = null;
  if (client) await client.close();
}
