import assert from 'assert';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const stateDir = join(tmpdir(), `pasture-llm-auth-${Date.now()}`);
process.env.PASTURE_STATE_DIR = stateDir;
mkdirSync(stateDir, { recursive: true });

try {
  const authMod = await import('../../../../lib/llm/auth.js?llm-auth-test');
  const {
    beginDeviceCodeLogin,
    completeDeviceCodeLogin,
    getLlmAuthStatus,
    hasUsableLlmAuth,
    isCodexManagedChatgptAuth,
    normalizeLlmAuth,
    readLlmAuthToken,
    resolveLlmAuthHeaders,
    writeLlmAuthToken,
  } = authMod;

  process.env.LLM_1_API_KEY = 'sk-test';
  const legacy = normalizeLlmAuth({ provider: 'openai', apiKey: 'LLM_1_API_KEY' }, 0);
  assert.deepStrictEqual(legacy, { type: 'api_key', env: 'LLM_1_API_KEY' });
  assert.strictEqual(getLlmAuthStatus(legacy).configured, true);

  delete process.env.LLM_1_API_KEY;
  assert.strictEqual(getLlmAuthStatus(legacy).configured, false);

  const chatgpt = normalizeLlmAuth({
    provider: 'openai',
    auth: {
      type: 'chatgpt',
      cache: 'must-not-be-used',
      clientId: 'must-not-be-used',
      authorizationUrl: 'https://example.test/authorize',
      tokenUrl: 'https://example.test/token',
    },
  }, 0);
  assert.deepStrictEqual(chatgpt, { type: 'chatgpt', provider: 'openai' });
  assert.strictEqual(isCodexManagedChatgptAuth(chatgpt, { provider: 'openai' }), true);
  assert.strictEqual(hasUsableLlmAuth(chatgpt, { provider: 'openai' }), true);
  assert.deepStrictEqual(await resolveLlmAuthHeaders(chatgpt, { provider: 'openai' }), {});
  assert.deepStrictEqual(getLlmAuthStatus(chatgpt), {
    type: 'chatgpt',
    configured: false,
    managed: 'codex',
    label: 'ChatGPT browser login',
  });

  const local = normalizeLlmAuth({ provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }, 0);
  assert.strictEqual(local.type, 'none');
  assert.strictEqual(getLlmAuthStatus(local).configured, true);

  const tokenPath = writeLlmAuthToken('openai-user', { access_token: 'tok-test', expires_at: Date.now() + 60_000 });
  assert(tokenPath.endsWith('openai-user.json'));
  assert.strictEqual(readLlmAuthToken('openai-user').access_token, 'tok-test');
  const oauth = normalizeLlmAuth({ provider: 'openai', auth: { type: 'oauth', cache: 'openai-user' } }, 0);
  assert.strictEqual(getLlmAuthStatus(oauth).configured, true);

  const xaiAuth = normalizeLlmAuth({ provider: 'grok', auth: { type: 'device_code', cache: 'grok-user' } }, 0);
  assert.strictEqual(xaiAuth.type, 'device_code');
  assert.strictEqual(xaiAuth.clientId, 'b1a00492-073a-47ea-816f-4c329264a828');
  assert.strictEqual(xaiAuth.discoveryUrl, 'https://auth.x.ai/.well-known/openid-configuration');

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('.well-known')) {
      return new Response(JSON.stringify({
        device_authorization_endpoint: 'https://auth.x.ai/oauth/device/code',
        token_endpoint: 'https://auth.x.ai/oauth/token',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/oauth/device/code')) {
      return new Response(JSON.stringify({
        device_code: 'dev-123',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.x.ai/activate',
        verification_uri_complete: 'https://auth.x.ai/activate?user_code=ABCD-EFGH',
        expires_in: 300,
        interval: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({
        access_token: 'xai-access',
        refresh_token: 'xai-refresh',
        expires_in: 3600,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const device = await beginDeviceCodeLogin(xaiAuth);
    assert.strictEqual(device.userCode, 'ABCD-EFGH');
    const login = await completeDeviceCodeLogin(xaiAuth, { ...device, intervalMs: 1 });
    assert.strictEqual(login.cache, 'grok-user');
    assert.strictEqual(readLlmAuthToken('grok-user').access_token, 'xai-access');
    assert(calls.some((url) => url.includes('.well-known')), 'device login used discovery');
  } finally {
    globalThis.fetch = originalFetch;
  }

  process.env.LLM_2_API_KEY = 'xai-test';
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({
    llm: {
      priorityMode: 'custom',
      models: [
        { provider: 'openai', model: 'gpt-test', auth: { type: 'oauth', cache: 'openai-user' }, priority: true },
        { provider: 'grok', model: 'grok-test', apiKey: 'LLM_2_API_KEY' },
      ],
    },
  }), 'utf8');
  const { loadConfig } = await import('../../../../llm.js?llm-auth-load-test');
  const cfg = loadConfig();
  assert.strictEqual(cfg.models.length, 2);
  assert.strictEqual(cfg.models[0].auth.type, 'oauth');
  assert.strictEqual(cfg.models[1].auth.type, 'api_key');

  console.log('test-llm-auth passed');
} finally {
  delete process.env.LLM_1_API_KEY;
  delete process.env.LLM_2_API_KEY;
  rmSync(stateDir, { recursive: true, force: true });
}
