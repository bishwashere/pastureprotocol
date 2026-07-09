import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { getStateDir } from '../util/paths.js';

const AUTH_DIR = 'llm-auth';
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const XAI_OAUTH_DEFAULTS = {
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access',
  discoveryUrl: 'https://auth.x.ai/.well-known/openid-configuration',
};

function cleanName(value, fallback = 'default') {
  const s = String(value || '').trim().replace(/[^0-9a-zA-Z._-]/g, '_');
  return s || fallback;
}

function resolveEnvOrValue(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (process.env[s] !== undefined) return String(process.env[s] || '').trim() || null;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(s)) return null;
  return s;
}

function resolveSecret(auth, field, envField) {
  if (!auth || typeof auth !== 'object') return null;
  if (auth[envField]) return resolveEnvOrValue(auth[envField]);
  if (auth[field]) return resolveEnvOrValue(auth[field]);
  return null;
}

function isXaiProvider(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return p === 'xai' || p === 'grok';
}

function withProviderAuthDefaults(auth = {}, entry = {}) {
  const next = { ...auth };
  const provider = String(entry.provider || next.provider || '').trim().toLowerCase();
  if (isXaiProvider(provider) && (next.type === 'device_code' || next.type === 'xai_oauth' || next.type === 'oauth')) {
    next.type = 'device_code';
    next.provider = provider || 'xai';
    next.cache = next.cache || next.account || 'xai';
    next.clientId = next.clientId || XAI_OAUTH_DEFAULTS.clientId;
    next.scope = next.scope || XAI_OAUTH_DEFAULTS.scope;
    next.discoveryUrl = next.discoveryUrl || XAI_OAUTH_DEFAULTS.discoveryUrl;
  }
  return next;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sha256Base64Url(input) {
  return base64Url(createHash('sha256').update(input).digest());
}

export function getLlmAuthDir() {
  return join(getStateDir(), AUTH_DIR);
}

export function getLlmAuthCachePath(cacheName) {
  return join(getLlmAuthDir(), `${cleanName(cacheName)}.json`);
}

export function normalizeLlmAuth(entry = {}, index = 0) {
  const provider = String(entry.provider || '').trim().toLowerCase();
  const isLocal = provider === 'lmstudio' || provider === 'ollama' || /127\.0\.0\.1|localhost/i.test(entry.baseUrl || '');
  const raw = entry.auth && typeof entry.auth === 'object' ? { ...entry.auth } : null;
  if (raw) {
    raw.type = String(raw.type || (isLocal ? 'none' : '')).trim().toLowerCase();
    if (!raw.type) raw.type = isLocal ? 'none' : 'api_key';
    if (!raw.cache) raw.cache = raw.account || `${provider || 'llm'}-${index + 1}`;
    return withProviderAuthDefaults(raw, entry);
  }

  if (entry.apiKey != null) {
    return { type: 'api_key', env: String(entry.apiKey).trim() };
  }

  if (isLocal) return { type: 'none' };
  if (index === 0 && process.env.LLM_API_KEY !== undefined) return { type: 'api_key', env: 'LLM_API_KEY' };
  return { type: 'missing' };
}

export function hasUsableLlmAuth(auth = {}, entry = {}) {
  const type = String(auth.type || '').toLowerCase();
  if (type === 'none') return true;
  if (type === 'api_key') return !!resolveSecret(auth, 'value', 'env');
  if (type === 'bearer_token') return !!resolveBearerToken(auth);
  if (type === 'oauth' || type === 'device_code') return existsSync(getLlmAuthCachePath(auth.cache || auth.account || entry.provider || 'default'));
  return false;
}

export function resolveBearerToken(auth = {}) {
  const direct = resolveSecret(auth, 'value', 'env') || resolveSecret(auth, 'token', 'tokenEnv');
  if (direct) return direct;
  if (auth.file) {
    try {
      const p = resolve(String(auth.file));
      const raw = readFileSync(p, 'utf8').trim();
      return raw || null;
    } catch (_) {
      return null;
    }
  }
  if (auth.cache) {
    const token = readLlmAuthToken(auth.cache);
    return token?.access_token || token?.accessToken || null;
  }
  return null;
}

export function readLlmAuthToken(cacheName) {
  try {
    const raw = readFileSync(getLlmAuthCachePath(cacheName), 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

export function writeLlmAuthToken(cacheName, token) {
  mkdirSync(getLlmAuthDir(), { recursive: true });
  const path = getLlmAuthCachePath(cacheName);
  writeFileSync(path, JSON.stringify(token || {}, null, 2), { mode: 0o600 });
  return path;
}

function tokenExpiresSoon(token) {
  const expiresAt = Number(token?.expires_at || token?.expiresAt || 0);
  return expiresAt > 0 && Date.now() >= expiresAt - 60_000;
}

async function refreshOAuthToken(auth, token) {
  if (!token?.refresh_token || !auth.tokenUrl) return token;
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', token.refresh_token);
  body.set('client_id', String(auth.clientId || ''));
  const clientSecret = resolveSecret(auth, 'clientSecret', 'clientSecretEnv');
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth refresh failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const next = await res.json();
  const merged = formatOAuthToken(auth, { ...token, ...next });
  writeLlmAuthToken(auth.cache || auth.account || 'default', merged);
  return merged;
}

export async function resolveLlmAuthHeaders(auth = {}, entry = {}) {
  const type = String(auth.type || '').toLowerCase();
  if (!type || type === 'none') return {};
  if (type === 'api_key') {
    const key = resolveSecret(auth, 'value', 'env');
    if (!key || key === 'not-needed') return {};
    if ((entry.baseUrl || '').includes('anthropic.com')) return { 'x-api-key': key };
    return { Authorization: `Bearer ${key}` };
  }
  if (type === 'bearer_token') {
    const token = resolveBearerToken(auth);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
  if (type === 'oauth') {
    const cache = auth.cache || auth.account || entry.provider || 'default';
    let token = readLlmAuthToken(cache);
    if (!token) return {};
    if (tokenExpiresSoon(token)) token = await refreshOAuthToken({ ...auth, tokenUrl: auth.tokenUrl || token.token_endpoint || token.tokenEndpoint, cache }, token);
    const access = token?.access_token || token?.accessToken;
    return access ? { Authorization: `Bearer ${access}` } : {};
  }
  if (type === 'device_code') {
    const cache = auth.cache || auth.account || entry.provider || 'default';
    let token = readLlmAuthToken(cache);
    if (!token) return {};
    if (tokenExpiresSoon(token)) token = await refreshOAuthToken({ ...auth, tokenUrl: auth.tokenUrl || token.token_endpoint || token.tokenEndpoint, cache }, token);
    const access = token?.access_token || token?.accessToken;
    return access ? { Authorization: `Bearer ${access}` } : {};
  }
  return {};
}

export function getLlmAuthStatus(auth = {}, entry = {}) {
  const type = String(auth.type || '').toLowerCase();
  if (type === 'none') return { type, configured: true, label: 'none' };
  if (type === 'api_key') {
    const env = auth.env || '';
    return { type, configured: !!resolveSecret(auth, 'value', 'env'), label: env ? `env:${env}` : 'api key' };
  }
  if (type === 'bearer_token') {
    return { type, configured: !!resolveBearerToken(auth), label: auth.env ? `env:${auth.env}` : (auth.file ? `file:${auth.file}` : 'bearer token') };
  }
  if (type === 'oauth' || type === 'device_code') {
    const cache = auth.cache || auth.account || entry.provider || 'default';
    const token = readLlmAuthToken(cache);
    return {
      type,
      configured: !!(token?.access_token || token?.accessToken),
      cache,
      expiresAt: token?.expires_at || token?.expiresAt || null,
      label: `${type}:${cache}`,
    };
  }
  return { type: type || 'missing', configured: false, label: type || 'missing' };
}

export function createOAuthLoginRequest(auth, callbackBaseUrl) {
  if (!auth?.authorizationUrl || !auth?.tokenUrl || !auth?.clientId) {
    throw new Error('OAuth auth requires authorizationUrl, tokenUrl, and clientId in config.');
  }
  const verifier = base64Url(randomBytes(48));
  const state = base64Url(randomBytes(24));
  const redirectUri = new URL('/api/llm-auth/callback', callbackBaseUrl).toString();
  const url = new URL(auth.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', sha256Base64Url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (auth.scope || auth.scopes) {
    const scope = Array.isArray(auth.scopes) ? auth.scopes.join(' ') : String(auth.scope || '');
    if (scope.trim()) url.searchParams.set('scope', scope.trim());
  }
  return { url: url.toString(), state, verifier, redirectUri };
}

export function formatOAuthToken(auth, token) {
  const now = Date.now();
  const expiresIn = Number(token.expires_in || token.expiresIn || 0);
  return {
    provider: auth.provider || null,
    account: auth.account || null,
    token_type: token.token_type || token.tokenType || 'Bearer',
    access_token: token.access_token || token.accessToken,
    refresh_token: token.refresh_token || token.refreshToken || null,
    scope: token.scope || auth.scope || (Array.isArray(auth.scopes) ? auth.scopes.join(' ') : null),
    token_endpoint: token.token_endpoint || token.tokenEndpoint || auth.tokenUrl || null,
    device_authorization_endpoint: token.device_authorization_endpoint || token.deviceAuthorizationEndpoint || auth.deviceAuthorizationUrl || null,
    created_at: now,
    expires_at: expiresIn > 0 ? now + expiresIn * 1000 : (token.expires_at || token.expiresAt || null),
  };
}

export async function exchangeOAuthCode(auth, code, verifier, redirectUri) {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);
  body.set('client_id', auth.clientId);
  body.set('code_verifier', verifier);
  const clientSecret = resolveSecret(auth, 'clientSecret', 'clientSecretEnv');
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(auth.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth token exchange failed ${res.status}: ${text.slice(0, 200)}`);
  }
  return formatOAuthToken(auth, await res.json());
}

function assertHttpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${label} must use https`);
  return url.toString();
}

async function discoverDeviceCodeEndpoints(auth = {}) {
  if (auth.deviceAuthorizationUrl && auth.tokenUrl) {
    return {
      deviceAuthorizationUrl: assertHttpsUrl(auth.deviceAuthorizationUrl, 'Device authorization URL'),
      tokenUrl: assertHttpsUrl(auth.tokenUrl, 'Token URL'),
    };
  }
  if (auth.authorizationUrl && auth.tokenUrl) {
    return {
      deviceAuthorizationUrl: assertHttpsUrl(auth.authorizationUrl, 'Device authorization URL'),
      tokenUrl: assertHttpsUrl(auth.tokenUrl, 'Token URL'),
    };
  }
  if (!auth.discoveryUrl) {
    throw new Error('Device-code auth requires discoveryUrl, or deviceAuthorizationUrl plus tokenUrl.');
  }
  const res = await fetch(assertHttpsUrl(auth.discoveryUrl, 'Discovery URL'), {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OAuth discovery failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.device_authorization_endpoint || !json.token_endpoint) {
    throw new Error('OAuth discovery response is missing device_authorization_endpoint or token_endpoint.');
  }
  return {
    deviceAuthorizationUrl: assertHttpsUrl(json.device_authorization_endpoint, 'Device authorization URL'),
    tokenUrl: assertHttpsUrl(json.token_endpoint, 'Token URL'),
  };
}

export async function beginDeviceCodeLogin(auth = {}) {
  const normalized = withProviderAuthDefaults(auth, auth);
  if (!normalized.clientId) throw new Error('Device-code auth requires clientId.');
  const endpoints = await discoverDeviceCodeEndpoints(normalized);
  const body = new URLSearchParams();
  body.set('client_id', normalized.clientId);
  if (normalized.scope || normalized.scopes) {
    body.set('scope', Array.isArray(normalized.scopes) ? normalized.scopes.join(' ') : String(normalized.scope || ''));
  }
  const res = await fetch(endpoints.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Device-code request failed ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const deviceCode = json.device_code || json.deviceCode;
  const userCode = json.user_code || json.userCode;
  const verificationUri = json.verification_uri || json.verificationUri;
  const verificationUriComplete = json.verification_uri_complete || json.verificationUriComplete;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('Device-code response is missing device_code, user_code, or verification_uri.');
  }
  return {
    cache: normalized.cache || normalized.account || normalized.provider || 'default',
    clientId: normalized.clientId,
    deviceCode,
    userCode,
    verificationUri: assertHttpsUrl(verificationUri, 'Device verification URI'),
    verificationUriComplete: verificationUriComplete ? assertHttpsUrl(verificationUriComplete, 'Complete device verification URI') : null,
    expiresInMs: Math.max(1, Number(json.expires_in || json.expiresIn || 300)) * 1000,
    intervalMs: Math.max(1, Number(json.interval || 5)) * 1000,
    tokenUrl: endpoints.tokenUrl,
    deviceAuthorizationUrl: endpoints.deviceAuthorizationUrl,
    scope: normalized.scope || null,
    provider: normalized.provider || null,
  };
}

function deviceCodeError(json = {}) {
  const error = json.error || '';
  const description = json.error_description || json.errorDescription || '';
  return { error, description };
}

export async function completeDeviceCodeLogin(auth = {}, device = {}) {
  const cache = device.cache || auth.cache || auth.account || auth.provider || 'default';
  const deadline = Date.now() + (Number(device.expiresInMs) || 300_000);
  let intervalMs = Number(device.intervalMs) || 5000;
  while (Date.now() < deadline) {
    const body = new URLSearchParams();
    body.set('grant_type', auth.grantType || DEVICE_CODE_GRANT_TYPE);
    body.set('client_id', device.clientId || auth.clientId);
    body.set('device_code', device.deviceCode);
    const res = await fetch(device.tokenUrl || auth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const token = formatOAuthToken(auth, {
        ...json,
        token_endpoint: device.tokenUrl || auth.tokenUrl,
        device_authorization_endpoint: device.deviceAuthorizationUrl || auth.deviceAuthorizationUrl,
      });
      const path = writeLlmAuthToken(cache, token);
      return { cache, path, token };
    }
    const { error, description } = deviceCodeError(json);
    if (error === 'authorization_pending') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
      continue;
    }
    if (error === 'slow_down') {
      intervalMs += 5000;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
      continue;
    }
    if (error === 'access_denied' || error === 'authorization_denied') throw new Error('Device authorization was denied.');
    if (error === 'expired_token') throw new Error('Device code expired. Re-run login.');
    throw new Error(`Device token exchange failed ${res.status}${error ? `: ${error}` : ''}${description ? ` (${description})` : ''}`);
  }
  throw new Error('Device authorization timed out.');
}

export async function runDeviceCodeLogin({ auth, openUrl, note }) {
  const device = await beginDeviceCodeLogin(auth);
  const url = device.verificationUriComplete || device.verificationUri;
  const message = [
    'Open this URL in your browser:',
    url,
    `Code: ${device.userCode}`,
  ].join('\n');
  if (typeof note === 'function') note(message, device);
  else console.log(message);
  if (typeof openUrl === 'function') openUrl(url);
  const result = await completeDeviceCodeLogin(auth, device);
  return { ...result, device };
}

export async function runOAuthLogin({ auth, openUrl, callbackHost = '127.0.0.1', callbackPort = 0, timeoutMs = 180_000 }) {
  const server = createServer();
  const listenUrl = await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(callbackPort, callbackHost, () => {
      const addr = server.address();
      resolveListen(`http://${callbackHost}:${addr.port}`);
    });
  });
  const login = createOAuthLoginRequest(auth, listenUrl);
  const cache = auth.cache || auth.account || auth.provider || 'default';

  return await new Promise((resolveLogin, rejectLogin) => {
    const timer = setTimeout(() => {
      server.close();
      rejectLogin(new Error('OAuth login timed out.'));
    }, timeoutMs);

    server.on('request', async (req, res) => {
      try {
        const u = new URL(req.url, listenUrl);
        if (u.pathname !== '/api/llm-auth/callback') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        const code = u.searchParams.get('code');
        const state = u.searchParams.get('state');
        if (!code || state !== login.state) throw new Error('OAuth callback state mismatch.');
        const token = await exchangeOAuthCode({ ...auth, cache }, code, login.verifier, login.redirectUri);
        const path = writeLlmAuthToken(cache, token);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><title>Pasture LLM auth</title><p>Login complete. You can close this tab.</p>');
        clearTimeout(timer);
        server.close();
        resolveLogin({ cache, path });
      } catch (err) {
        res.statusCode = 400;
        res.end(err?.message || 'OAuth login failed.');
        clearTimeout(timer);
        server.close();
        rejectLogin(err);
      }
    });

    if (typeof openUrl === 'function') openUrl(login.url);
    else console.log(login.url);
  });
}
