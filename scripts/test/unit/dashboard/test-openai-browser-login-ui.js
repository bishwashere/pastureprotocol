#!/usr/bin/env node
import assert from 'assert';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..', '..');
const dashboardJs = readFileSync(join(root, 'dashboard/public/assets/js/02-crons-skills-agents.js'), 'utf8');
const dashboardServer = readFileSync(join(root, 'dashboard/server.js'), 'utf8');
const dashboardHtml = readFileSync(join(root, 'dashboard/public/index.html'), 'utf8');

const authHelpersStart = dashboardJs.indexOf('function configIsLocalLlmProvider(');
assert(authHelpersStart >= 0, 'dashboard auth helpers are present');
const authHelpersSource = dashboardJs.slice(authHelpersStart);
const authHelpers = new Function('escapeHtml', `${authHelpersSource}\nreturn {
  configAuthOptionsForProvider,
  configNormalizeAuthTypeForProvider
};`)((value) => String(value));

assert.deepStrictEqual(
  authHelpers.configAuthOptionsForProvider('openai', 'api_key'),
  [
    { value: 'api_key', label: 'API key' },
    { value: 'oauth', label: 'Browser login' },
  ],
  'OpenAI offers API key and browser-login auth',
);
assert.strictEqual(
  authHelpers.configNormalizeAuthTypeForProvider('oauth', 'openai'),
  'oauth',
  'OpenAI browser-login selection remains oauth for saved-auth import',
);
assert.deepStrictEqual(
  authHelpers.configAuthOptionsForProvider('xai', 'device_code').map((item) => item.value),
  ['api_key', 'device_code'],
  'xAI device-code login remains available',
);

assert(!dashboardJs.includes('Login once'), 'dashboard no longer says Login once');
assert(dashboardJs.includes('>Connect</button>'), 'browser auth action uses neutral Connect wording');

assert(
  dashboardServer.includes('importOpenAiBrowserAuth') &&
    !dashboardServer.includes('startCodexChatGptLogin'),
  'OpenAI browser-login route imports existing saved auth instead of starting a fresh popup flow',
);
assert(
  dashboardServer.includes("method: 'imported'"),
  'OpenAI saved-auth import reports imported login status',
);

const collectStart = dashboardJs.indexOf('function collectConfigFromUi(');
const collectEnd = dashboardJs.indexOf('function applyConfigViewMode(', collectStart);
assert(collectStart >= 0 && collectEnd > collectStart, 'config serialization helper is present');
const collectSource = dashboardJs.slice(collectStart, collectEnd);
assert(collectSource.includes('var priorityRadio = document.querySelector'), 'priority is read from the selected radio');
assert(collectSource.includes('if (i === priorityIdx) o.priority = true;'), 'only the selected model receives priority');
assert(
  collectSource.indexOf('if (i === priorityIdx) o.priority = true;') > collectSource.indexOf('auth: auth'),
  'priority is applied independently from auth serialization',
);
assert(!collectSource.includes('configured'), 'config save does not infer priority from login/configured state');

const normalizeStart = dashboardServer.indexOf('function normalizeProjectLlmPriority(');
const normalizeEnd = dashboardServer.indexOf('function saveConfig(', normalizeStart);
assert(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'project config priority normalizer is present');
const normalizeProjectLlmPriority = new Function(
  `${dashboardServer.slice(normalizeStart, normalizeEnd)}\nreturn normalizeProjectLlmPriority;`,
)();
const normalizedPriorityConfig = normalizeProjectLlmPriority({
  llm: {
    models: [
      { provider: 'lmstudio', model: 'local', priority: true },
      { provider: 'openai', model: 'gpt-4o', priority: 'true' },
      { provider: 'anthropic', model: 'claude' },
    ],
  },
});
assert.deepStrictEqual(
  normalizedPriorityConfig.llm.models.map((m) => !!m.priority),
  [true, false, false],
  'JSON config save keeps one canonical priority flag',
);
assert(
  dashboardServer.includes('const normalized = normalizeProjectLlmPriority(config || {});'),
  'all root config saves normalize the same priority field used by UI and JSON modes',
);

assert(dashboardHtml.includes('assets/js/02-crons-skills-agents.js?v=39'), 'dashboard cachebuster is current');

console.log('test-openai-browser-login-ui passed');
