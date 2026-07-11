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
import { getConfigPath, getEnvPath, getAuthDir, getCronStorePath, ensureStateDir, getWorkspaceDir } from './lib/util/paths.js';
import { beginCliSession, statusOk } from './lib/util/cli-banner.js';

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
  beginCliSession();
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
    if (activeSetupSession) activeSetupSession.flushOnQuit();
    console.log('Quit.');
    process.exit(0);
  }
}

/** Active setup session — set during onboarding/messaging prompts for save-on-quit. */
let activeSetupSession = null;

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
    console.log(statusOk('  ✓ Migrated config.json to ~/.pasture'));
  }
  if (existsSync(rootEnv) && !existsSync(stateEnv)) {
    copyFileSync(rootEnv, stateEnv);
    console.log(statusOk('  ✓ Migrated .env to ~/.pasture'));
  }
  if (existsSync(rootAuth)) {
    const creds = join(rootAuth, 'creds.json');
    if (existsSync(creds) && !existsSync(join(stateAuth, 'creds.json'))) {
      cpSync(rootAuth, stateAuth, { recursive: true });
      console.log(statusOk('  ✓ Migrated auth_info to ~/.pasture'));
    }
  }
  if (existsSync(rootCron) && !existsSync(stateCron)) {
    mkdirSync(dirname(stateCron), { recursive: true });
    copyFileSync(rootCron, stateCron);
    console.log(statusOk('  ✓ Migrated cron/jobs.json to ~/.pasture'));
  }
}

function ensureInstall() {
  const nodeModules = join(ROOT, 'node_modules');
  const requiredDependencies = [
    join(nodeModules, '@whiskeysockets', 'baileys'),
    join(nodeModules, '@openai', 'codex', 'bin', 'codex.js'),
  ];
  if (!existsSync(nodeModules) || requiredDependencies.some((path) => !existsSync(path))) {
    const pm = getPackageManager();
    section('Installing dependencies');
    console.log('  Running: ' + pm + ' install');
    console.log('');
    const res = spawnSync(pm, ['install'], { cwd: ROOT, stdio: 'inherit' });
    if (res.status !== 0) {
      console.error('  ' + pm + ' install failed.');
      process.exit(res.status ?? 1);
    }
    if (requiredDependencies.some((path) => !existsSync(path))) {
      console.error('  Required dependencies are still missing after install.');
      process.exit(1);
    }
    console.log('');
    console.log(statusOk('  ✓ Dependencies ready.'));
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
  console.log(statusOk('  ✓ Bio saved to config and WhoAmI.md.'));
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

function valuesDiffer(before, after) {
  return String(before ?? '').trim() !== String(after ?? '').trim();
}

/** Incremental save during pasture setup — writes ~/.pasture only when a value changes. */
function createSetupSession(initialEnv) {
  const envPath = getEnvPath();
  const pendingEnv = { ...initialEnv };
  let envDirty = false;
  let savedThisRun = false;

  function flushEnv() {
    if (!envDirty) return false;
    ensureStateDir();
    writeFileSync(envPath, stringifyEnv(pendingEnv), 'utf8');
    envDirty = false;
    savedThisRun = true;
    return true;
  }

  function setEnv(key, value) {
    const prev = pendingEnv[key] ?? '';
    const next = value ?? '';
    if (!valuesDiffer(prev, next)) return false;
    pendingEnv[key] = next;
    envDirty = true;
    return flushEnv();
  }

  function saveConfigIfChanged(updateFn) {
    let config = loadConfig() || ensureConfig();
    const before = JSON.stringify(config);
    updateFn(config);
    if (before === JSON.stringify(config)) return false;
    saveConfig(config);
    savedThisRun = true;
    return true;
  }

  function flushOnQuit() {
    flushEnv();
    if ((pendingEnv.LLM_1_API_KEY || '').trim()) {
      wireWhisperToOpenAiKey({ pendingEnv, saveConfigIfChanged });
    }
    if (savedThisRun) {
      console.log(statusOk('  ✓ Saved changes to ~/.pasture'));
    }
  }

  return { pendingEnv, setEnv, saveConfigIfChanged, flushOnQuit };
}

async function setupPromptSecret(session, envKey, prompt, existingVal) {
  const display = existingVal ? maskSecret(existingVal) : '';
  const def = display ? ` [${display}]` : '';
  const answer = await ask(`${prompt}${def} (q to quit): `);
  checkQuit(answer);
  const next = answer || existingVal || '';
  session.setEnv(envKey, next);
  return next;
}

async function setupPromptDefault(prompt, defaultVal) {
  const def = defaultVal ? ` [${defaultVal}]` : '';
  const answer = await ask(`${prompt}${def} (q to quit): `);
  checkQuit(answer);
  return answer || defaultVal || '';
}

function wireWhisperToOpenAiKey(session) {
  if (!(session.pendingEnv.LLM_1_API_KEY || '').trim()) return;
  session.saveConfigIfChanged((cfg) => {
    if (!cfg.skills) cfg.skills = {};
    if (!cfg.skills.speech) cfg.skills.speech = {};
    cfg.skills.speech.whisper = { apiKey: 'LLM_1_API_KEY' };
  });
}

function saveCloudLlmSelection(session, provider, selectedModel) {
  if (provider === 'skip' || !selectedModel) return;
  session.saveConfigIfChanged((cfg) => {
    if (!Array.isArray(cfg?.llm?.models)) return;
    const models = cfg.llm.models;
    for (let i = 0; i < models.length; i++) {
      const p = (models[i].provider || '').toLowerCase();
      const isChosen = p === provider;
      if (isChosen) {
        models[i].priority = true;
        models[i].model = selectedModel;
      } else if (Object.prototype.hasOwnProperty.call(models[i], 'priority')) {
        delete models[i].priority;
      }
    }
  });
}

function saveSpeechConfig(session, whisperChoice) {
  session.saveConfigIfChanged((cfg) => {
    if (!cfg.skills) cfg.skills = {};
    if (!cfg.skills.speech) cfg.skills.speech = {};
    if (whisperChoice === 'openai') {
      cfg.skills.speech.whisper = { apiKey: 'LLM_1_API_KEY' };
    } else if (whisperChoice === 'separate' && (session.pendingEnv.SPEECH_WHISPER_API_KEY || '').trim()) {
      cfg.skills.speech.whisper = { apiKey: 'SPEECH_WHISPER_API_KEY' };
    }
    cfg.skills.speech.elevenLabs = { apiKey: 'ELEVEN_LABS_API_KEY' };
  });
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
  const session = createSetupSession(env);
  activeSetupSession = session;

  try {
  section('Configuration (optional — press Enter to keep defaults or skip)');

  const baseUrl = await setupPromptDefault(q('Local LLM base URL (e.g. LM Studio)'), defaultBaseUrl || '');
  if (valuesDiffer(defaultBaseUrl || '', baseUrl)) {
    session.saveConfigIfChanged((cfg) => {
      if (cfg?.llm?.models?.[0]) cfg.llm.models[0].baseUrl = baseUrl;
    });
  }

  // Cloud LLM: ask provider directly, with skip
  let llm1Key = session.pendingEnv.LLM_1_API_KEY || '';
  let llm2Key = session.pendingEnv.LLM_2_API_KEY || '';
  let llm3Key = session.pendingEnv.LLM_3_API_KEY || '';

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
    llm1Key = await setupPromptSecret(session, 'LLM_1_API_KEY', q('OpenAI API key'), session.pendingEnv.LLM_1_API_KEY || '');
    if ((llm1Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel);
    wireWhisperToOpenAiKey(session);
  } else if (provider === 'grok') {
    const models = CLOUD_LLM_MODELS.grok;
    selectedModel = await selectModel(q('Grok model version'), models);
    llm2Key = await setupPromptSecret(session, 'LLM_2_API_KEY', q('Grok API key'), session.pendingEnv.LLM_2_API_KEY || '');
    if ((llm2Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel);
  } else if (provider === 'anthropic') {
    const models = CLOUD_LLM_MODELS.anthropic;
    selectedModel = await selectModel(q('Anthropic (Claude) model version'), models);
    llm3Key = await setupPromptSecret(session, 'LLM_3_API_KEY', q('Anthropic API key'), session.pendingEnv.LLM_3_API_KEY || '');
    if ((llm3Key || '').trim()) saveCloudLlmSelection(session, provider, selectedModel);
  }

  await setupPromptSecret(session, 'BRAVE_API_KEY', q('Brave Search API key – optional'), session.pendingEnv.BRAVE_API_KEY || '');

  // Google Workspace (gog) skill
  const enableGogAnswer = await ask(q('Enable Google Workspace (gog) skill? (y/n)') + ' ');
  const enableGog = (enableGogAnswer || '').trim().toLowerCase().startsWith('y');
  if (enableGog) {
    config = loadConfig() || config;
    const existingAccount = config?.skills?.gog?.account ? String(config.skills.gog.account) : '';
    const gogAccount = await setupPromptDefault(q('Default Google account email for gog (optional)'), existingAccount || '');
    session.saveConfigIfChanged((cfg) => {
      if (!cfg.skills) cfg.skills = {};
      const skills = cfg.skills;
      const enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
      if (!enabled.includes('gog')) enabled.push('gog');
      skills.enabled = enabled;
      if (!skills.gog) skills.gog = {};
      if (gogAccount && gogAccount.trim()) skills.gog.account = gogAccount.trim();
      cfg.skills = skills;
    });
    if (!hasBinary('gog')) {
      console.log(C.dim + '  ! gog CLI not found in PATH. Install from https://gogcli.sh and run setup again.' + C.reset);
    }
    console.log(statusOk('  ✓ gog skill enabled.'));
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
    const visionModel = visionFallbackProvider === 'openai'
      ? await selectModel(q('OpenAI vision model'), CLOUD_LLM_MODELS.openai)
      : await selectModel(q('Anthropic vision model'), CLOUD_LLM_MODELS.anthropic);
    session.saveConfigIfChanged((cfg) => {
      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.vision) cfg.skills.vision = {};
      cfg.skills.vision.fallback = {
        provider: visionFallbackProvider,
        model: visionModel || (visionFallbackProvider === 'openai' ? 'gpt-5.2' : 'claude-sonnet-4-5-20250929'),
        apiKey: visionFallbackProvider === 'openai' ? 'LLM_1_API_KEY' : 'LLM_3_API_KEY',
      };
    });
  }

  // Speech (voice): Whisper = voice-to-text, 11Labs = text-to-voice. Separate from LLM setup.
  section('Speech (voice)');
  const hasOpenAIKey = (session.pendingEnv.LLM_1_API_KEY || '').trim().length > 0;
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
  if (whisperChoice === 'openai') {
    saveSpeechConfig(session, whisperChoice);
  } else if (whisperChoice === 'separate') {
    await setupPromptSecret(session, 'SPEECH_WHISPER_API_KEY', q('Whisper/OpenAI API key'), session.pendingEnv.SPEECH_WHISPER_API_KEY || '');
    saveSpeechConfig(session, whisperChoice);
  }
  await setupPromptSecret(session, 'ELEVEN_LABS_API_KEY', q('11Labs API key (text to voice) – optional'), session.pendingEnv.ELEVEN_LABS_API_KEY || '');

  console.log('');
  console.log(statusOk('  ✓ Config and .env saved to ~/.pasture'));
  } finally {
    activeSetupSession = null;
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
    const msgSession = createSetupSession(env);
    activeSetupSession = msgSession;
    try {
      const telegramToken = await setupPromptSecret(msgSession, 'TELEGRAM_BOT_TOKEN', q('Telegram bot token (from @BotFather)'), env.TELEGRAM_BOT_TOKEN || '');
      if (telegramToken) {
        env.TELEGRAM_BOT_TOKEN = telegramToken;
        msgSession.saveConfigIfChanged((cfg) => {
          cfg.channels = cfg.channels || {};
          cfg.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
        });
        console.log(statusOk('  ✓ Telegram token saved.'));
      }
    } finally {
      activeSetupSession = null;
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
        const msgSession = createSetupSession(env);
        activeSetupSession = msgSession;
        try {
          const telegramToken = await setupPromptSecret(msgSession, 'TELEGRAM_BOT_TOKEN', q('Telegram bot token (from @BotFather)'), env.TELEGRAM_BOT_TOKEN || '');
          if (telegramToken) {
            env.TELEGRAM_BOT_TOKEN = telegramToken;
            msgSession.saveConfigIfChanged((cfg) => {
              cfg.channels = cfg.channels || {};
              cfg.channels.telegram = { enabled: true, botToken: 'TELEGRAM_BOT_TOKEN' };
            });
            console.log(statusOk('  ✓ Telegram token saved.'));
          }
        } finally {
          activeSetupSession = null;
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
