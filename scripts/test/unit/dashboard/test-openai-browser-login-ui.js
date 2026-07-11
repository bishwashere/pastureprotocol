#!/usr/bin/env node
import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..', '..');
const dashboardJs = readFileSync(join(root, 'dashboard/public/assets/js/02-crons-skills-agents.js'), 'utf8');
const dashboardHtml = readFileSync(join(root, 'dashboard/public/index.html'), 'utf8');

const authHelpersStart = dashboardJs.indexOf('function configIsLocalLlmProvider(');
assert(authHelpersStart >= 0, 'dashboard auth helpers are present');
const authHelpersSource = dashboardJs.slice(authHelpersStart);
const authHelpers = new Function('escapeHtml', `${authHelpersSource}\nreturn {
  configAuthOptionsForProvider,
  configNormalizeAuthTypeForProvider,
  configHasCustomOAuthSettings
};`)((value) => String(value));

assert.deepStrictEqual(
  authHelpers.configAuthOptionsForProvider('openai', 'api_key'),
  [
    { value: 'api_key', label: 'API key' },
    { value: 'chatgpt', label: 'ChatGPT login' },
  ],
  'OpenAI offers API key and managed ChatGPT login',
);
assert.deepStrictEqual(
  authHelpers.configAuthOptionsForProvider('openai', 'oauth').map((item) => item.value),
  ['api_key', 'chatgpt', 'oauth'],
  'an existing custom OpenAI OAuth entry remains editable as legacy OAuth',
);
assert.strictEqual(
  authHelpers.configNormalizeAuthTypeForProvider('chatgpt', 'openai'),
  'chatgpt',
  'OpenAI Browser login keeps the chatgpt auth type',
);
assert.deepStrictEqual(
  authHelpers.configAuthOptionsForProvider('xai', 'device_code').map((item) => item.value),
  ['api_key', 'device_code'],
  'xAI device-code login remains available',
);
assert.strictEqual(
  authHelpers.configHasCustomOAuthSettings({ type: 'oauth', authorizationUrl: 'https://example.test/auth' }),
  true,
  'custom OAuth settings are detected for backward compatibility',
);
assert.strictEqual(
  authHelpers.configHasCustomOAuthSettings({ type: 'oauth', cache: 'old-openai' }),
  false,
  'a bare old OpenAI OAuth selection can migrate to managed browser auth',
);

const hiddenStart = dashboardJs.indexOf('function configAuthFieldHidden(');
const hiddenEnd = dashboardJs.indexOf('function configHiddenAttr(', hiddenStart);
assert(hiddenStart >= 0 && hiddenEnd > hiddenStart, 'auth field visibility helper is present');
const configAuthFieldHidden = new Function(
  `${dashboardJs.slice(hiddenStart, hiddenEnd)}\nreturn configAuthFieldHidden;`,
)();
assert.strictEqual(configAuthFieldHidden('chatgpt', 'cache'), true, 'Browser login hides the login-name field');
assert.strictEqual(configAuthFieldHidden('chatgpt', 'oauth'), true, 'Browser login hides advanced OAuth endpoints');
assert.strictEqual(configAuthFieldHidden('chatgpt', 'chatgpt'), false, 'Browser login shows its account status row');
assert.strictEqual(configAuthFieldHidden('device_code', 'login'), false, 'device-code login keeps its login action');

const connectedStart = dashboardJs.indexOf('function configChatGptAuthIsConnected(');
const connectedEnd = dashboardJs.indexOf('async function refreshConfigLlmAuthStatus(', connectedStart);
assert(connectedStart >= 0 && connectedEnd > connectedStart, 'ChatGPT connection-status helper is present');
const configChatGptAuthIsConnected = new Function(
  `${dashboardJs.slice(connectedStart, connectedEnd)}\nreturn configChatGptAuthIsConnected;`,
)();
assert.strictEqual(
  configChatGptAuthIsConnected({ auth: { type: 'chatgpt', configured: true } }),
  true,
  'managed ChatGPT auth reports connected',
);
assert.strictEqual(
  configChatGptAuthIsConnected({ auth: { type: 'oauth', configured: true } }),
  false,
  'a configured legacy OAuth cache is not mistaken for managed ChatGPT auth',
);
assert.strictEqual(
  configChatGptAuthIsConnected({ auth: { type: 'chatgpt', configured: false } }),
  false,
  'signed-out managed ChatGPT auth reports disconnected',
);

const pollingStart = dashboardJs.indexOf('function configDelay(');
const pollingEnd = dashboardJs.indexOf('function finishConfigLlmPopup(', pollingStart);
assert(pollingStart >= 0 && pollingEnd > pollingStart, 'login polling helpers are present');
const pollingCalls = [];
const pollingStatuses = [];
const pollingHelpers = new Function(
  'fetch',
  'API',
  'CONFIG_LLM_LOGIN_POLL_MS',
  'CONFIG_LLM_LOGIN_MAX_POLLS',
  'CONFIG_LLM_POPUP_CHECK_MS',
  `${dashboardJs.slice(pollingStart, pollingEnd)}\nreturn { pollConfigLlmLogin, cancelConfigChatGptLogin };`,
)(async (url, options = {}) => {
  pollingCalls.push({ url: String(url), method: options.method || 'GET' });
  return { ok: true, json: async () => ({ status: pollingStatuses.shift() || 'pending' }) };
}, '', 1, 1, 1);

pollingStatuses.push('pending');
await assert.rejects(
  pollingHelpers.pollConfigLlmLogin('/api/llm-auth/chatgpt/test-id', { closed: true }),
  (error) => error && error.code === 'LLM_LOGIN_POPUP_CLOSED',
  'a still-pending final status preserves popup-close failure',
);
assert.deepStrictEqual(
  pollingCalls,
  [{ url: '/api/llm-auth/chatgpt/test-id', method: 'GET' }],
  'closing the popup performs exactly one final backend status read',
);

pollingCalls.length = 0;
pollingStatuses.push('complete');
const completedAfterClose = await pollingHelpers.pollConfigLlmLogin(
  '/api/llm-auth/chatgpt/completed-id',
  { closed: true },
);
assert.strictEqual(completedAfterClose.status, 'complete', 'a hosted success-page close is accepted as success');
assert.deepStrictEqual(
  pollingCalls,
  [{ url: '/api/llm-auth/chatgpt/completed-id', method: 'GET' }],
  'the success race also uses only one final status read',
);

pollingCalls.length = 0;
await pollingHelpers.cancelConfigChatGptLogin('test id');
assert.deepStrictEqual(
  pollingCalls,
  [{ url: '/api/llm-auth/chatgpt/test%20id', method: 'DELETE' }],
  'pending ChatGPT login cancellation uses the DELETE endpoint',
);

const minimalAuthStart = dashboardJs.indexOf("if (authType === 'chatgpt') {");
const minimalAuthEnd = dashboardJs.indexOf("} else if (authType === 'api_key')", minimalAuthStart);
assert(minimalAuthStart >= 0 && minimalAuthEnd > minimalAuthStart, 'chatgpt config serialization branch is present');
const minimalAuthBranch = dashboardJs.slice(minimalAuthStart, minimalAuthEnd);
assert(minimalAuthBranch.includes("auth = { type: 'chatgpt' };"), 'Browser login saves minimal chatgpt auth config');
assert(!minimalAuthBranch.includes('clientId') && !minimalAuthBranch.includes('tokenUrl'), 'Browser login saves no OAuth setup fields');

const beginStart = dashboardJs.indexOf('function beginConfigLlmLoginFromUserGesture(');
const beginEnd = dashboardJs.indexOf('function wireConfigUiActions(', beginStart);
assert(beginStart >= 0 && beginEnd > beginStart, 'user-gesture login starter is present');
const beginSource = dashboardJs.slice(beginStart, beginEnd);
assert(!beginSource.startsWith('async '), 'the popup starter is synchronous');
assert(
  beginSource.indexOf('configOpenLlmLoginPopup()') < beginSource.indexOf('startConfigLlmLogin(card, popup)'),
  'the blank popup opens before asynchronous login work starts',
);

assert.strictEqual(
  (dashboardJs.match(/fetch\(API \+ '\/api\/llm-auth\/login'/g) || []).length,
  1,
  'the dashboard has one login-start request site',
);
assert(dashboardJs.includes("'/api/llm-auth/chatgpt/' + encodeURIComponent(d.id)"), 'managed OpenAI login is polled');
assert(dashboardJs.includes('finalConfigLlmStatusAfterPopupClose(url)'), 'popup-close polling performs a final status read');
assert(dashboardJs.includes('CONFIG_LLM_POPUP_CHECK_MS = 250'), 'popup closure is detected promptly between polls');
assert(dashboardJs.includes("method: 'DELETE'"), 'unsuccessful managed login requests backend cancellation');
assert(
  dashboardJs.includes('if (isChatGpt && chatGptLoginId) cancelConfigChatGptLogin(chatGptLoginId)'),
  'ChatGPT close, error, and timeout paths clean up the pending login',
);
assert(dashboardJs.includes("showConfigSavedNotice('ChatGPT login complete.')"), 'successful login is reported clearly');
assert(dashboardJs.includes('finishConfigLlmPopup(popup)'), 'the login popup is closed and dashboard focus is restored');
assert(dashboardJs.includes("fetch(API + '/api/llm-auth/status')"), 'existing chatgpt configs load connection status');

const renderStart = dashboardJs.indexOf('function renderConfigUi(');
const renderEnd = dashboardJs.indexOf('function configModelCardIndex(', renderStart);
const renderSource = dashboardJs.slice(renderStart, renderEnd);
assert(!renderSource.includes('beginConfigLlmLoginFromUserGesture'), 'rendering an existing chatgpt config does not start login');
assert(dashboardHtml.includes('assets/js/02-crons-skills-agents.js?v=38'), 'dashboard cachebuster was updated');

console.log('test-openai-browser-login-ui passed');
