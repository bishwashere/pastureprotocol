#!/usr/bin/env node
/**
 * One-command setup: install deps, one-time onboarding (base URL, optional API keys), then run the app.
 * On first run the app will show QR to link WhatsApp, then start the bot.
 * Usage: pasture setup | npm run setup | pnpm run setup | node setup.js
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { spawnSync, spawn } from 'child_process';
import { getConfigPath, getEnvPath, getAuthDir, getCronStorePath, ensureStateDir, getWorkspaceDir } from './lib/paths.js';

/** Default Tide checklist block — inlined so setup.js does not import tide-checklist.js (needs dotenv) before deps install. */
function defaultTideChecklistBlock() {
  return {
    enabled: false,
    triggers: { onRestart: true, onCycle: true, onFollowUp: false },
    items: [
      {
        id: 'telegram-polling',
        label: 'Telegram polling health',
        prompt:
          'Confirm Telegram bot polling is healthy and the daemon can receive messages. Use tools if needed. Report OK or FAIL briefly.',
        enabled: true,
      },
    ],
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const ENV_EXAMPLE = join(ROOT, '.env.example');

const C = { reset: '\x1b[0m', cyan: '\x1b[36m', dim: '\x1b[2m', green: '\x1b[32m', bold: '\x1b[1m' };

/** Theme for @inquirer/select: always show navigate + select + Ctrl+C quit (never undefined so tooltip always visible). */
function selectTheme() {
  const tipParts = [
    ['↑↓', 'navigate'],
    ['⏎', 'select'],
    ['Ctrl+C', 'quit'],
  ];
  const helpTipString = tipParts
    .map(([k, a]) => `${C.bold}${k}${C.reset} ${C.dim}${a}${C.reset}`)
    .join(C.dim + ' • ' + C.reset);
  return {
    style: {
      keysHelpTip() {
        return helpTipString;
      },
    },
  };
}
/** Color the main question label so all prompts look consistent. */
function q(label) {
  return C.cyan + label + C.reset;
}
function section(title) {
  console.log('');
  console.log(C.dim + '  ─────────────────────────────────────────' + C.reset);
  console.log(C.dim + '  ' + title + C.reset);
  console.log(C.dim + '  ─────────────────────────────────────────' + C.reset);
  console.log('');
}
function welcome() {
  console.log('');
  console.log(C.green + '  Welcome to Pasture Protocol' + C.reset);
  console.log(C.dim + '  WhatsApp + Telegram bot powered by your own LLM (local or cloud)' + C.reset);
  console.log('');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || '').trim());
    });
  });
}

/** Read one paragraph: lines until user enters an empty line. */
function askParagraph(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    console.log(prompt);
    rl.on('line', (line) => {
      if ((line || '').trim() === '') {
        rl.close();
        resolve(lines.join('\n').trim());
        return;
      }
      lines.push(line || '');
    });
  });
}

function checkQuit(answer) {
  if (answer && answer.toLowerCase() === 'q') {
    if (typeof onboardingEnvFlush === 'function') onboardingEnvFlush();
    console.log('Quit.');
    process.exit(0);
  }
}

/** When set during onboarding(), writes pending .env changes before early quit. */
let onboardingEnvFlush = null;

/** Prompt with full default value shown (e.g. for base URL). Press q to quit. */
async function promptWithDefault(prompt, defaultVal) {
  const def = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await ask(`${prompt}${def} (q to quit): `);
  checkQuit(answer);
  return answer || defaultVal || '';
}

/** Select one of the model choices; returns the value (API model id). */
async function selectModel(message, choices) {
  if (!Array.isArray(choices) || choices.length === 0) return '';
  try {
    const select = (await import('@inquirer/select')).default;
    return await select({ message, choices, theme: selectTheme() });
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('@inquirer/select')) {
      const line = choices.map((c, i) => `${i + 1}. ${c.name}`).join('\n  ');
      const answer = await ask(`${message}\n  ${line}\n  Number or name (q to quit): `);
      checkQuit(answer);
      const n = parseInt(answer, 10);
      if (n >= 1 && n <= choices.length) return choices[n - 1].value;
      const byName = choices.find((c) => c.name.toLowerCase().includes((answer || '').toLowerCase()));
      return byName ? byName.value : choices[0].value;
    }
    throw err;
  }
}

/** Mask a secret for display: e.g. "sk-proj-Qx4ue..." -> "sk-proj-Qx***" */
function maskSecret(val) {
  if (!val || typeof val !== 'string') return '';
  const s = val.trim();
  if (s.length <= 8) return '***';
  return s.slice(0, 12) + '***';
}

/** Prompt for a secret; if already set, show masked hint. Press q to quit. */
async function promptSecret(prompt, existingVal) {
  const display = existingVal ? maskSecret(existingVal) : '';
  const def = display ? ` [${display}]` : '';
  const answer = await ask(`${prompt}${def} (q to quit): `);
  checkQuit(answer);
  return answer || existingVal || '';
}

/**
 * Cloud LLM provider → list of model choices for setup.
 * Value is the API model id. First option per provider is the recommended/latest.
 */
const CLOUD_LLM_MODELS = {
  openai: [
    { name: 'GPT-5.2 (recommended)', value: 'gpt-5.2' },
    { name: 'GPT-5 mini', value: 'gpt-5-mini' },
    { name: 'GPT-5 nano', value: 'gpt-5-nano' },
    { name: 'GPT-5.2 pro', value: 'gpt-5.2-pro' },
    { name: 'GPT-5', value: 'gpt-5' },
    { name: 'GPT-4.1', value: 'gpt-4.1' },
    { name: 'GPT-4.1 mini', value: 'gpt-4.1-mini' },
    { name: 'GPT-4.1 nano', value: 'gpt-4.1-nano' },
    { name: 'GPT-4o', value: 'gpt-4o' },
    { name: 'GPT-4o mini', value: 'gpt-4o-mini' },
    { name: 'GPT-4 Turbo', value: 'gpt-4-turbo' },
    { name: 'GPT-4', value: 'gpt-4' },
  ],
  grok: [
    { name: 'Grok 4.1 Fast reasoning (recommended)', value: 'grok-4-1-fast-reasoning' },
    { name: 'Grok 4.1 Fast non-reasoning', value: 'grok-4-1-fast-non-reasoning' },
    { name: 'Grok 4', value: 'grok-4-0709' },
    { name: 'Grok 4 Fast reasoning', value: 'grok-4-fast-reasoning' },
    { name: 'Grok 4 Fast non-reasoning', value: 'grok-4-fast-non-reasoning' },
    { name: 'Grok 3', value: 'grok-3' },
    { name: 'Grok 3 mini', value: 'grok-3-mini' },
    { name: 'Grok 2 vision', value: 'grok-2-vision-1212' },
    { name: 'Grok 2', value: 'grok-2' },
  ],
  anthropic: [
    { name: 'Claude Opus 4.6 (recommended)', value: 'claude-opus-4-6' },
    { name: 'Claude Sonnet 4.5', value: 'claude-sonnet-4-5-20250929' },
    { name: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
    { name: 'Claude 3.5 Sonnet', value: 'claude-3-5-sonnet-20241022' },
    { name: 'Claude 3.5 Haiku', value: 'claude-3-5-haiku-20241022' },
    { name: 'Claude 3 Opus', value: 'claude-3-opus-20240229' },
  ],
};

/** Vision fallback: used only when the agent model is text-only (e.g. Llama, GPT-3.5). Same keys as main LLM. */
const VISION_FALLBACK_CHOICES = [
  { name: 'Skip (use only if your main model supports vision)', value: 'skip' },
  { name: 'OpenAI GPT-4o (vision)', value: 'openai' },
  { name: 'Anthropic Claude (vision)', value: 'anthropic' },
];

/** True if this provider+model is known to support vision (e.g. GPT-4o/5.x, Claude 3/4.x, Grok 4.x/2-vision). */
function isVisionCapable(provider, modelId) {
  const p = (provider || '').toLowerCase();
  const m = (modelId || '').toLowerCase();
  if (p === 'openai') return /^gpt-(4|5)/.test(m);
  if (p === 'anthropic') return /^claude-(3|opus-4|sonnet-4|haiku-4)/.test(m);
  if (p === 'grok' || p === 'xai') return /^grok-(4|2-vision)/.test(m);
  return false;
}

/** Returns first available package manager: pnpm, npm, or yarn. */
function getPackageManager() {
  for (const cmd of ['pnpm', 'npm', 'yarn']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout && String(r.stdout).trim().length > 0) return cmd;
  }
  return 'npm';
}

function hasBinary(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { stdio: 'ignore' });
  return res.status === 0;
}

function migrateFromRoot() {
  ensureStateDir();
  const stateConfig = getConfigPath();
  const stateEnv = getEnvPath();
  const stateAuth = getAuthDir();
  const stateCron = getCronStorePath();
  const rootConfig = join(ROOT, 'config.json');
  const rootEnv = join(ROOT, '.env');
  const rootAuth = join(ROOT, 'auth_info');
  const rootCron = join(ROOT, 'cron', 'jobs.json');
  if (existsSync(rootConfig) && !existsSync(stateConfig)) {
    copyFileSync(rootConfig, stateConfig);
    console.log(C.dim + '  ✓ Migrated config.json to ~/.pasture' + C.reset);
  }
  if (existsSync(rootEnv) && !existsSync(stateEnv)) {
    copyFileSync(rootEnv, stateEnv);
    console.log(C.dim + '  ✓ Migrated .env to ~/.pasture' + C.reset);
  }
  if (existsSync(rootAuth)) {
    const creds = join(rootAuth, 'creds.json');
    if (existsSync(creds) && !existsSync(join(stateAuth, 'creds.json'))) {
      cpSync(rootAuth, stateAuth, { recursive: true });
      console.log(C.dim + '  ✓ Migrated auth_info to ~/.pasture' + C.reset);
    }
  }
  if (existsSync(rootCron) && !existsSync(stateCron)) {
    mkdirSync(dirname(stateCron), { recursive: true });
    copyFileSync(rootCron, stateCron);
    console.log(C.dim + '  ✓ Migrated cron/jobs.json to ~/.pasture' + C.reset);
  }
}

function ensureInstall() {
  const nodeModules = join(ROOT, 'node_modules');
  if (!existsSync(nodeModules) || !existsSync(join(nodeModules, '@whiskeysockets', 'baileys'))) {
    const pm = getPackageManager();
    section('Installing dependencies');
    console.log('  Running: ' + pm + ' install');
    console.log('');
    const res = spawnSync(pm, ['install'], { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) {
      console.error('  ' + pm + ' install failed.');
      process.exit(res.status ?? 1);
    }
    console.log('');
    console.log(C.dim + '  ✓ Dependencies ready.' + C.reset);
  }
}

/** Copy repo workspace-default/*.md into state workspace if they don't exist. */
function ensureWorkspaceDefaults() {
  ensureStateDir();
  const defaultDir = join(ROOT, 'workspace-default');
  const workspaceDir = getWorkspaceDir();
  const names = ['WhoAmI.md', 'MyHuman.md', 'SOUL.md'];
  for (const name of names) {
    const dest = join(workspaceDir, name);
    if (existsSync(dest)) continue;
    const src = join(defaultDir, name);
    if (existsSync(src)) {
      try {
        copyFileSync(src, dest);
      } catch (_) {}
    }
  }
}

/** On first install, ask four bio questions and save as config.bio (separate from system prompt). */
async function askBioAndSave() {
  ensureConfig();
  const config = loadConfig();
  const bio = config?.bio;
  const hasBio =
    bio != null &&
    (typeof bio === 'string' ? (bio || '').trim() !== '' : typeof bio === 'object' && (bio.userName != null || bio.prompt != null));
  if (hasBio) return;

  section('About you and your assistant');
  console.log('  ' + q('What is my name?'));
  console.log('  ' + q('What is your name?'));
  console.log('  ' + q('Who am I?'));
  console.log('  ' + q('Who are you?'));
  console.log('');
  console.log('  (One paragraph answer is fine — any format, press Enter twice when done.)');
  console.log('');

  const paragraph = await askParagraph('  Your answer (q to quit): ');
  if ((paragraph || '').toLowerCase().trim() === 'q') {
    console.log('Quit.');
    process.exit(0);
  }

  const text = (paragraph || '').trim() || '';
  config.bio = text;
  saveConfig(config);
  if (text) {
    try {
      ensureStateDir();
      writeFileSync(join(getWorkspaceDir(), 'WhoAmI.md'), text, 'utf8');
    } catch (_) {}
  }
  console.log('');
  console.log(C.dim + '  ✓ Bio saved to config and WhoAmI.md.' + C.reset);
}

function loadConfig() {
  if (!existsSync(getConfigPath())) return null;
  try {
    return JSON.parse(readFileSync(getConfigPath(), 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

/** Detect host timezone (IANA) and 12/24 format; set in config so install sets them, not "auto". */
function ensureAgentsDefaultsFromHost() {
  const config = loadConfig();
  if (!config) return;
  if (!config.agents) config.agents = {};
  if (!config.agents.defaults) config.agents.defaults = {};
  const def = config.agents.defaults;
  const tz = def.userTimezone != null ? String(def.userTimezone).trim() : '';
  const fmt = def.timeFormat != null ? String(def.timeFormat).trim().toLowerCase() : '';
  let changed = false;
  if (!tz || tz.toLowerCase() === 'auto') {
    try {
      config.agents.defaults.userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      changed = true;
    } catch {
      config.agents.defaults.userTimezone = 'UTC';
      changed = true;
    }
  }
  if (!fmt || fmt === 'auto') {
    try {
      const opts = Intl.DateTimeFormat().resolvedOptions();
      const hour12 = opts.hour12;
      if (hour12 === true) config.agents.defaults.timeFormat = '12';
      else if (hour12 === false) config.agents.defaults.timeFormat = '24';
      else {
        const sample = new Intl.DateTimeFormat(opts.locale, { hour: 'numeric' }).formatToParts(new Date());
        config.agents.defaults.timeFormat = sample.some((p) => p.type === 'dayPeriod') ? '12' : '24';
      }
      changed = true;
    } catch {
      config.agents.defaults.timeFormat = '12';
      changed = true;
    }
  }
  if (changed) saveConfig(config);
}

function getDefaultBaseUrl(config) {
  const first = config?.llm?.models?.[0];
  if (first?.baseUrl) return first.baseUrl;
  return 'http://127.0.0.1:1234/v1';
}

function parseEnv(content) {
  const lines = (content || '').split('\n');
  const out = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key && !key.startsWith('#')) out[key] = val;
  }
  return out;
}

function stringifyEnv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function ensureConfig() {
  let config = loadConfig();
  if (!config) {
    const rootConfig = join(ROOT, 'config.json');
    if (existsSync(rootConfig)) {
      try {
        config = JSON.parse(readFileSync(rootConfig, 'utf8'));
        ensureStateDir();
        saveConfig(config);
      } catch {
        config = {};
      }
    }
    if (!config || !config.llm) {
      config = config || {};
      config.llm = config.llm || {
        maxTokens: 2048,
        models: [
          { provider: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: 'not-needed' },
          { provider: 'openai', apiKey: 'LLM_1_API_KEY' },
          { provider: 'grok', apiKey: 'LLM_2_API_KEY' },
          { provider: 'anthropic', apiKey: 'LLM_3_API_KEY' },
        ],
      };
      ensureStateDir();
      saveConfig(config);
    }
  }
  if (config && !config.tide) {
    config.tide = {
      enabled: false,
      silenceCooldownMinutes: 30,
      inactiveStart: '23:00',
      inactiveEnd: '06:00',
      checklist: defaultTideChecklistBlock(),
    };
    saveConfig(config);
  }
  return config;
}

async function onboarding() {
  let config = ensureConfig();
  const defaultBaseUrl = getDefaultBaseUrl(config);
  const envPath = getEnvPath();
  const hasEnv = existsSync(envPath);
  const envContent = hasEnv ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(envContent);
  const pendingEnv = { ...env };
  let envDirty = false;

  function markEnvDirty() {
    envDirty = true;
  }

  function flushEnv(force) {
    if (!force && !envDirty) return;
    ensureStateDir();
    writeFileSync(envPath, stringifyEnv(pendingEnv), 'utf8');
    envDirty = false;
  }

  function wireWhisperToOpenAiKey() {
    if (!(pendingEnv.LLM_1_API_KEY || '').trim()) return;
    config = loadConfig() || config;
    if (!config.skills) config.skills = {};
    if (!config.skills.speech) config.skills.speech = {};
    config.skills.speech.whisper = { apiKey: 'LLM_1_API_KEY' };
    saveConfig(config);
  }

  onboardingEnvFlush = () => {
    if (!envDirty) return;
    flushEnv(true);
    if ((pendingEnv.LLM_1_API_KEY || '').trim()) wireWhisperToOpenAiKey();
    console.log(C.dim + '  ✓ Saved changes to ~/.pasture' + C.reset);
  };

  try {
  section('Configuration (optional — press Enter to keep defaults or skip)');

  const baseUrl = await promptWithDefault(q('Local LLM base URL (e.g. LM Studio)'), defaultBaseUrl || '');

  // Cloud LLM: ask provider directly, with skip
  let llm1Key = pendingEnv.LLM_1_API_KEY || '';
  let llm2Key = pendingEnv.LLM_2_API_KEY || '';
  let llm3Key = pendingEnv.LLM_3_API_KEY || '';

  let provider;
  try {
    const select = (await import('@inquirer/select')).default;
    provider = await select({
      message: q('Cloud LLM provider?'),
      choices: [
        { name: 'Skip', value: 'skip' },
        { name: 'OpenAI', value: 'openai' },
        { name: 'Grok', value: 'grok' },
        { name: 'Anthropic', value: 'anthropic' },
        { name: 'Quit', value: 'quit' },
      ],
      theme: selectTheme(),
    });
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('@inquirer/select')) {
      const answer = await ask(q('Cloud LLM provider?') + ' (skip / openai / grok / anthropic, q to quit): ');
      checkQuit(answer);
      provider = (answer || '').trim().toLowerCase() || 'skip';
    } else {
      throw err;
    }
  }
  if (provider === 'quit') {
    console.log('Quit.');
    process.exit(0);
  }
  let selectedModel = '';
  if (provider === 'openai') {
    const models = CLOUD_LLM_MODELS.openai;
    selectedModel = await selectModel(q('OpenAI model version'), models);
    llm1Key = await promptSecret(q('OpenAI API key'), pendingEnv.LLM_1_API_KEY || '');
    pendingEnv.LLM_1_API_KEY = llm1Key ?? '';
    markEnvDirty();
    flushEnv(true);
    wireWhisperToOpenAiKey();
  } else if (provider === 'grok') {
    const models = CLOUD_LLM_MODELS.grok;
    selectedModel = await selectModel(q('Grok model version'), models);
    llm2Key = await promptSecret(q('Grok API key'), pendingEnv.LLM_2_API_KEY || '');
    pendingEnv.LLM_2_API_KEY = llm2Key ?? '';
    markEnvDirty();
    flushEnv(true);
  } else if (provider === 'anthropic') {
    const models = CLOUD_LLM_MODELS.anthropic;
    selectedModel = await selectModel(q('Anthropic (Claude) model version'), models);
    llm3Key = await promptSecret(q('Anthropic API key'), pendingEnv.LLM_3_API_KEY || '');
    pendingEnv.LLM_3_API_KEY = llm3Key ?? '';
    markEnvDirty();
    flushEnv(true);
  }

  const braveKey = await promptSecret(q('Brave Search API key – optional'), pendingEnv.BRAVE_API_KEY || '');
  pendingEnv.BRAVE_API_KEY = braveKey ?? '';
  markEnvDirty();
  flushEnv(true);

  // Google Workspace (gog) skill
  const enableGogAnswer = await ask(q('Enable Google Workspace (gog) skill? (y/n)') + ' ');
  const enableGog = (enableGogAnswer || '').trim().toLowerCase().startsWith('y');
  if (enableGog) {
    config = loadConfig() || config;
    if (!config.skills) config.skills = {};
    const skills = config.skills;
    const enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
    if (!enabled.includes('gog')) enabled.push('gog');
    skills.enabled = enabled;
    if (!skills.gog) skills.gog = {};
    const existingAccount = skills.gog.account ? String(skills.gog.account) : '';
    const gogAccount = await promptWithDefault(q('Default Google account email for gog (optional)'), existingAccount || '');
    if (gogAccount && gogAccount.trim()) skills.gog.account = gogAccount.trim();
    config.skills = skills;
    saveConfig(config);
    if (!hasBinary('gog')) {
      console.log(C.dim + '  ! gog CLI not found in PATH. Install from https://gogcli.sh and run setup again.' + C.reset);
    }
    console.log(C.dim + '  ✓ gog skill enabled.' + C.reset);
  }

  // Vision fallback: only ask when main model is text-only; skip step if main model already supports vision.
  let mainModelSupportsVision = false;
  if (provider !== 'skip') {
    mainModelSupportsVision = isVisionCapable(provider, selectedModel);
  } else {
    config = loadConfig() || config;
    const models = config?.llm?.models;
    if (Array.isArray(models) && models.length > 0) {
      const priority = models.find((m) => m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true');
      const main = priority || models[0];
      mainModelSupportsVision = isVisionCapable(main.provider, main.model);
    }
  }

  let visionFallbackProvider = 'skip';
  if (!mainModelSupportsVision) {
    try {
      const select = (await import('@inquirer/select')).default;
      visionFallbackProvider = await select({
        message: q('Vision fallback for image reading? (when your main model is text-only)'),
        choices: VISION_FALLBACK_CHOICES,
        theme: selectTheme(),
      });
    } catch (err) {
      if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('@inquirer/select')) {
        const answer = await ask(q('Vision fallback?') + ' (skip / openai / anthropic, q to quit): ');
        checkQuit(answer);
        visionFallbackProvider = (answer || '').trim().toLowerCase() || 'skip';
      } else {
        throw err;
      }
    }
  }
  if (visionFallbackProvider === 'openai' || visionFallbackProvider === 'anthropic') {
    config = loadConfig() || config;
    if (!config.skills) config.skills = {};
    if (!config.skills.vision) config.skills.vision = {};
    const visionModel = visionFallbackProvider === 'openai'
      ? await selectModel(q('OpenAI vision model'), CLOUD_LLM_MODELS.openai)
      : await selectModel(q('Anthropic vision model'), CLOUD_LLM_MODELS.anthropic);
    config.skills.vision.fallback = {
      provider: visionFallbackProvider,
      model: visionModel || (visionFallbackProvider === 'openai' ? 'gpt-5.2' : 'claude-sonnet-4-5-20250929'),
      apiKey: visionFallbackProvider === 'openai' ? 'LLM_1_API_KEY' : 'LLM_3_API_KEY',
    };
    saveConfig(config);
  }

  // Speech (voice): Whisper = voice-to-text, 11Labs = text-to-voice. Separate from LLM setup.
  section('Speech (voice)');
  let speechWhisperKey = '';
  let elevenLabsKey = pendingEnv.ELEVEN_LABS_API_KEY || '';
  const hasOpenAIKey = (pendingEnv.LLM_1_API_KEY || '').trim().length > 0;
  let whisperChoice = 'skip';
  try {
    const select = (await import('@inquirer/select')).default;
    whisperChoice = await select({
      message: q('Whisper (voice to text)?'),
      choices: [
        { name: 'Skip', value: 'skip' },
        ...(hasOpenAIKey ? [{ name: 'Use existing OpenAI key (LLM_1_API_KEY)', value: 'openai' }] : []),
        { name: 'Enter separate Whisper/OpenAI key', value: 'separate' },
      ],
      theme: selectTheme(),
    });
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('@inquirer/select')) {
      const answer = await ask(q('Whisper?') + ' (skip / openai / separate, q to quit): ');
      checkQuit(answer);
      whisperChoice = (answer || '').trim().toLowerCase() || 'skip';
      if (whisperChoice === 'openai' && !hasOpenAIKey) whisperChoice = 'skip';
    } else {
      throw err;
    }
  }
  if (whisperChoice === 'separate') {
    speechWhisperKey = await promptSecret(q('Whisper/OpenAI API key'), pendingEnv.SPEECH_WHISPER_API_KEY || '');
    pendingEnv.SPEECH_WHISPER_API_KEY = speechWhisperKey ?? '';
    markEnvDirty();
    flushEnv(true);
  }
  elevenLabsKey = await promptSecret(q('11Labs API key (text to voice) – optional'), elevenLabsKey || '');
  pendingEnv.ELEVEN_LABS_API_KEY = elevenLabsKey ?? '';
  markEnvDirty();
  flushEnv(true);
  config = loadConfig() || config;
  if (!config.skills) config.skills = {};
  if (!config.skills.speech) config.skills.speech = {};
  if (whisperChoice === 'openai') {
    config.skills.speech.whisper = { apiKey: 'LLM_1_API_KEY' };
  } else if (whisperChoice === 'separate' && (pendingEnv.SPEECH_WHISPER_API_KEY || '').trim()) {
    config.skills.speech.whisper = { apiKey: 'SPEECH_WHISPER_API_KEY' };
  }
  config.skills.speech.elevenLabs = { apiKey: 'ELEVEN_LABS_API_KEY' };
  saveConfig(config);

  if (baseUrl && config?.llm?.models?.[0]) {
    config.llm.models[0].baseUrl = baseUrl;
    saveConfig(config);
  }

  flushEnv(true);

  // When user adds a cloud LLM key during setup, set that model as priority and chosen version.
  const cloudKeyAdded = provider !== 'skip' && (
    (provider === 'openai' && (llm1Key ?? '').trim()) ||
    (provider === 'grok' && (llm2Key ?? '').trim()) ||
    (provider === 'anthropic' && (llm3Key ?? '').trim())
  );
  if (cloudKeyAdded && Array.isArray(config?.llm?.models)) {
    const models = config.llm.models;
    const hasPriorityAlready = models.some(
      (m) => m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true'
    );
    if (!hasPriorityAlready) {
      for (let i = 0; i < models.length; i++) {
        const p = (models[i].provider || '').toLowerCase();
        const isChosen = p === provider;
        models[i].priority = isChosen;
        if (isChosen && selectedModel) models[i].model = selectedModel;
      }
      saveConfig(config);
    } else if (selectedModel) {
      // Re-run setup: still update the chosen provider's model version.
      for (let i = 0; i < models.length; i++) {
        if ((models[i].provider || '').toLowerCase() === provider) {
          models[i].model = selectedModel;
          saveConfig(config);
          break;
        }
      }
    }
  }

  console.log('');
  console.log(C.dim + '  ✓ Config and .env saved to ~/.pasture' + C.reset);
  } finally {
    onboardingEnvFlush = null;
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    console.log('Setup needs an interactive terminal.');
    console.log('Run: pasture setup');
    console.log('Or: cd Pasture Protocol && node setup.js');
    console.log('Or: cd Pasture Protocol && npm install && npm start\n');
    process.exit(0);
  }
  welcome();
  migrateFromRoot();
  ensureInstall();
  ensureWorkspaceDefaults();
  await askBioAndSave();
  ensureAgentsDefaultsFromHost();

  await onboarding();

  // Skip messaging setup if both WhatsApp and Telegram are already in the system (only re-link via pasture auth / token edit).
  const authDir = getAuthDir();
  const hasWhatsAppAuth = existsSync(authDir) && existsSync(join(authDir, 'creds.json'));
  const envPath = getEnvPath();
  const hasEnv = existsSync(envPath);
  const envContent = hasEnv ? readFileSync(envPath, 'utf8') : '';
  let env = parseEnv(envContent);
  const hasTelegramToken = !!(env.TELEGRAM_BOT_TOKEN || '').trim();
  const configForChannels = loadConfig() || {};
  const channels = configForChannels.channels || {};
  const whatsappDisabled = channels.whatsapp?.enabled === false;
  const bothAlreadySetUp = hasWhatsAppAuth && hasTelegramToken && !whatsappDisabled;
  const onlyTelegramSetUp = hasTelegramToken && (!hasWhatsAppAuth || whatsappDisabled);
  const onlyWhatsAppSetUp = hasWhatsAppAuth && !hasTelegramToken && !whatsappDisabled;
  const neitherSetUp = !hasWhatsAppAuth && !hasTelegramToken;

  let messagingFirst = 'whatsapp';
  let telegramOnly = false;

  if (!bothAlreadySetUp) {
    section('Messaging');
    // Only ask "which first?" when neither channel is set up; if one exists, skip to offering the other.
    if (neitherSetUp) {
      try {
        const select = (await import('@inquirer/select')).default;
        const choice = await select({
          message: q('Which do you want to set up first?'),
          choices: [
            { name: 'WhatsApp (link your phone)', value: 'whatsapp' },
            { name: 'Telegram (bot token from @BotFather)', value: 'telegram' },
          ],
          theme: selectTheme(),
        });
        messagingFirst = choice;
      } catch (err) {
        if (err?.code === 'ERR_MODULE_NOT_FOUND' || err?.message?.includes('@inquirer/select')) {
          const answer = await ask(q('Which first?') + ' (1=WhatsApp 2=Telegram, q to quit): ');
          checkQuit(answer);
          messagingFirst = (answer || '1').trim() === '2' ? 'telegram' : 'whatsapp';
        } else {
          throw err;
        }
      }
    }
    // onlyTelegramSetUp or onlyWhatsAppSetUp: messagingFirst stays 'whatsapp' (offer the missing channel below)
  }

  if (!bothAlreadySetUp && messagingFirst === 'telegram') {
    console.log('');
    const telegramToken = await promptSecret(q('Telegram bot token (from @BotFather)'), env.TELEGRAM_BOT_TOKEN || '');
    if (telegramToken) {
      env.TELEGRAM_BOT_TOKEN = telegramToken;
      writeFileSync(envPath, stringifyEnv(env), 'utf8');
      console.log(C.dim + '  ✓ Telegram token saved.' + C.reset);
      const config = loadConfig() || {};
      config.channels = config.channels || {};
      config.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
      saveConfig(config);
    }
    const addWa = await ask(q('Add WhatsApp too? (y/n)') + ' ');
    if ((addWa || '').toLowerCase().startsWith('y')) {
      console.log('');
      console.log('  Linking WhatsApp — a QR code or pairing prompt will appear.');
      console.log('');
      const authResult = spawnSync(process.execPath, [join(ROOT, 'index.js'), '--auth-only'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
      });
      if (authResult.status !== 0) {
        console.log(C.dim + '  WhatsApp linking failed or skipped. You can run: pasture auth' + C.reset);
      }
    } else {
      telegramOnly = true;
      const config = loadConfig() || {};
      config.channels = config.channels || {};
      config.channels.whatsapp = { enabled: false };
      if (!config.channels.telegram) config.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
      saveConfig(config);
    }
  } else if (!bothAlreadySetUp) {
    // WhatsApp first (or only Telegram exists and we're offering WhatsApp)
    if (onlyTelegramSetUp) {
      console.log('');
      const addWa = await ask(q('Add WhatsApp? (y/n)') + ' ');
      if ((addWa || '').toLowerCase().startsWith('y')) {
        console.log('');
        console.log('  Linking WhatsApp — a QR code or pairing prompt will appear.');
        console.log('');
        const authResult = spawnSync(process.execPath, [join(ROOT, 'index.js'), '--auth-only'], {
          cwd: ROOT,
          stdio: 'inherit',
          shell: false,
          env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
        });
        if (authResult.status !== 0) {
          console.log(C.dim + '  WhatsApp linking failed or skipped. You can run: pasture auth' + C.reset);
        }
      } else {
        telegramOnly = true;
        const config = loadConfig() || {};
        config.channels = config.channels || {};
        config.channels.whatsapp = { enabled: false };
        if (!config.channels.telegram) config.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
        saveConfig(config);
      }
    } else {
      // WhatsApp first: finish linking WhatsApp, then ask about Telegram
      console.log('');
      console.log('  Linking WhatsApp — a QR code or pairing prompt will appear.');
      console.log('');
      const authResult = spawnSync(process.execPath, [join(ROOT, 'index.js'), '--auth-only'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
      });
      if (authResult.status !== 0) {
        console.log(C.dim + '  WhatsApp linking failed or skipped. You can run: pasture auth' + C.reset);
      }
      console.log('');
      const addTg = await ask(q('Add Telegram too? (y/n)') + ' ');
      if ((addTg || '').toLowerCase().startsWith('y')) {
        const telegramToken = await promptSecret(q('Telegram bot token (from @BotFather)'), env.TELEGRAM_BOT_TOKEN || '');
        if (telegramToken) {
          env.TELEGRAM_BOT_TOKEN = telegramToken;
          writeFileSync(envPath, stringifyEnv(env), 'utf8');
          console.log(C.dim + '  ✓ Telegram token saved.' + C.reset);
          const config = loadConfig() || {};
          config.channels = config.channels || {};
          config.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
          saveConfig(config);
        }
      }
    }
  }

  section('Starting Pasture Protocol');
  if (telegramOnly) {
    console.log('  Running in Telegram-only mode. Message your bot on Telegram to chat.');
    console.log('  To add WhatsApp later: pasture auth  then  pasture start');
  } else {
    console.log('  If this is your first time with WhatsApp, you\'ll see a QR code — scan it.');
    console.log('  Then send a message to your own number to start chatting.');
    if (env.TELEGRAM_BOT_TOKEN) {
      console.log('  Telegram is also enabled — you can message your bot there.');
    }
  }
  console.log('');
  const child = spawn('node', ['index.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'development',
      ...(telegramOnly ? { PASTURE_TELEGRAM_ONLY: '1' } : {}),
    },
  });
  child.on('close', (code) => {
    console.log('');
    console.log('  ------------------------------------------------');
    console.log('  To start the bot:  pasture start');
    console.log('  (or from this folder:  npm start)');
    console.log('');
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
