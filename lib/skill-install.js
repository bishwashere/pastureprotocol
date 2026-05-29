/**
 * Skill install: add a skill to skills.enabled and prompt for required credentials.
 * Used by: cowcode add <skill-id> | cowcode skills install <skill-id>
 *
 * Storage is an implementation detail — users paste values here; we save to
 * secrets.json, .env, or config.json as each skill requires.
 */

import { createInterface } from 'readline';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { getConfigPath, getEnvPath, getSecretsPath, ensureStateDir } from './paths.js';

/** Aliases for skill id (e.g. homeassistant -> home-assistant). */
const SKILL_ALIASES = {
  homeassistant: 'home-assistant',
  homeassistnat: 'home-assistant',
  home_assistant: 'home-assistant',
  ha: 'home-assistant',
  google: 'gog',
};

/** Skills to enable when user runs cowcode add <id>. */
const ENABLE_BUNDLES = {
  google: ['gog', 'gmail', 'calendar'],
  gog: ['gog', 'gmail', 'calendar'],
  gmail: ['gog', 'gmail'],
  calendar: ['gog', 'calendar'],
};

/**
 * Env vars to prompt for when installing a skill.
 * @type {Record<string, { prompt: string, envVars: Array<{ name: string, prompt: string }> }>}
 */
const SKILL_INSTALL_PROMPTS = {
  'home-assistant': {
    prompt: 'Home Assistant',
    envVars: [
      { name: 'HA_URL', prompt: 'Home Assistant URL (optional, press Enter for http://localhost:8123)' },
      { name: 'HA_TOKEN', prompt: 'Home Assistant long-lived access token' },
    ],
  },
  speech: {
    prompt: 'Speech',
    envVars: [
      { name: 'ELEVEN_LABS_API_KEY', prompt: 'ElevenLabs API key (required for text-to-speech voice replies)' },
      { name: 'SPEECH_WHISPER_API_KEY', prompt: 'OpenAI key for Whisper transcription (optional; press Enter to use LLM_1_API_KEY)' },
      { name: 'ELEVEN_LABS_VOICE_ID', prompt: 'ElevenLabs voice id (optional; press Enter for default)' },
    ],
  },
  'ssh-inspect': {
    prompt: 'SSH inspect',
    envVars: [
      { name: 'SSH_INSPECT_USER', prompt: 'Default remote SSH user (optional; press Enter to use system default)' },
      { name: 'SSH_INSPECT_IDENTITY', prompt: 'Path to SSH private key (optional; press Enter to use ~/.ssh default)' },
      { name: 'SSH_INSPECT_TIMEOUT', prompt: 'Command timeout in seconds (optional; press Enter for 30)' },
    ],
  },
  search: {
    prompt: 'Web search (Brave)',
    envVars: [
      { name: 'BRAVE_API_KEY', prompt: 'Brave Search API key (https://brave.com/search/api/)' },
    ],
  },
};

function parseEnv(content) {
  const lines = (content || '').split('\n');
  const out = {};
  for (const line of lines) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (key && !key.startsWith('#')) out[key] = val;
  }
  return out;
}

function stringifyEnv(obj) {
  return Object.entries(obj)
    .map(([k, v]) => {
      const val = String(v ?? '');
      if (val.includes('=') || val.includes(' ') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        return `${k}="${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
      }
      return `${k}=${val}`;
    })
    .join('\n');
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

function maskSecret(val) {
  if (!val || typeof val !== 'string') return '';
  const s = val.trim();
  if (s.length <= 8) return '***';
  return s.slice(0, 12) + '***';
}

async function promptSecret(prompt, existingVal) {
  const display = existingVal ? maskSecret(existingVal) : '';
  const def = display ? ` [${display}]` : '';
  const answer = await ask(`${prompt}${def}: `);
  return answer || existingVal || '';
}

function hasBinary(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(cmd, [name], { stdio: 'ignore' });
  return res.status === 0;
}

function readSecrets() {
  const path = getSecretsPath();
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (_) {}
  return {};
}

function writeSecrets(secrets) {
  const path = getSecretsPath();
  writeFileSync(path, JSON.stringify(secrets, null, 2), 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch (_) {}
}

function listGogAccounts() {
  if (!hasBinary('gog')) return [];
  try {
    const result = spawnSync('gog', ['auth', 'list', '--json'], { encoding: 'utf8' });
    if (result.status !== 0) return [];
    const data = JSON.parse(result.stdout || '{}');
    return (data.accounts || [])
      .map((a) => a?.email)
      .filter((email) => email && String(email).trim());
  } catch (_) {
    return [];
  }
}

/**
 * Normalize user input to canonical skill id.
 * @param {string} raw - e.g. "homeassistant" or "home-assistant"
 * @returns {string} e.g. "home-assistant"
 */
export function normalizeSkillId(raw) {
  const s = (raw || '').trim().toLowerCase().replace(/\s+/g, '-');
  return SKILL_ALIASES[s] || s;
}

/**
 * Skills to add to skills.enabled for a user-facing skill id.
 * @param {string} rawSkillId
 * @param {string} canonicalId
 * @returns {string[]}
 */
export function getSkillsToEnable(rawSkillId, canonicalId) {
  const key = (rawSkillId || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (ENABLE_BUNDLES[key]) return [...ENABLE_BUNDLES[key]];
  return [canonicalId];
}

/**
 * Check if a skill exists (has SKILL.md in skills/<id>/).
 * @param {string} installDir - CowCode install root (contains skills/)
 * @param {string} skillId - Canonical skill id
 */
export function skillExists(installDir, skillId) {
  const mdPath = join(installDir, 'skills', skillId, 'SKILL.md');
  return existsSync(mdPath);
}

/**
 * Get list of skill ids that have install prompts (can be installed via this command).
 */
export function getInstallableSkillIds() {
  return [...new Set([...Object.keys(SKILL_INSTALL_PROMPTS), 'github', 'gog', 'gmail', 'calendar', 'google'])];
}

async function setupGithub(config, deps) {
  const { ask: askFn, promptSecret: promptSecretFn } = deps;
  console.log('  Create a token at https://github.com/settings/tokens');
  console.log('  Recommended scopes: repo, issues, pull_requests');
  console.log('');

  const secrets = readSecrets();
  const existingToken = secrets?.github?.token || process.env.GITHUB_TOKEN || '';
  const token = await promptSecretFn('  GitHub personal access token', existingToken);
  if (!token) {
    return { ok: false, message: 'GitHub token is required.' };
  }

  secrets.github = secrets.github || {};
  secrets.github.token = token;
  writeSecrets(secrets);
  console.log('  ✓ GitHub token saved.');

  config.skills = config.skills || {};
  config.skills.github = config.skills.github || {};
  const existingRepo = config.skills.github.defaultRepo || '';
  const repoPrompt = existingRepo
    ? `  Default repo owner/name (optional) [${existingRepo}]: `
    : '  Default repo owner/name (optional): ';
  const repo = await askFn(repoPrompt);
  if (repo) config.skills.github.defaultRepo = repo;

  return { ok: true };
}

async function setupGoogle(config, deps) {
  const { ask: askFn } = deps;

  if (!hasBinary('gog')) {
    console.log('  ! gog CLI not found in PATH.');
    console.log('  Install from https://gogcli.sh then run: cowcode add google');
    return { ok: false, message: 'gog CLI not installed.' };
  }

  let accounts = listGogAccounts();
  let account = '';

  if (accounts.length === 0) {
    console.log('  No Google account connected yet.');
    console.log('  Sign in via browser (gog will open OAuth).');
    console.log('');
    const email = await askFn('  Google account email: ');
    if (!email || !email.includes('@')) {
      return { ok: false, message: 'A valid Google account email is required.' };
    }
    console.log('');
    const authResult = spawnSync('gog', ['auth', 'add', email], { stdio: 'inherit' });
    if (authResult.status !== 0) {
      return { ok: false, message: 'Google sign-in failed or was skipped.' };
    }
    account = email;
  } else if (accounts.length === 1) {
    account = accounts[0];
    console.log(`  Connected Google account: ${account}`);
    const useExisting = await askFn('  Use this account? (Y/n): ');
    if (useExisting && /^n/i.test(useExisting)) {
      const email = await askFn('  Google account email to add: ');
      if (email && email.includes('@')) {
        console.log('');
        const authResult = spawnSync('gog', ['auth', 'add', email], { stdio: 'inherit' });
        if (authResult.status !== 0) {
          return { ok: false, message: 'Google sign-in failed or was skipped.' };
        }
        account = email;
      }
    }
  } else {
    console.log('  Connected Google accounts:');
    accounts.forEach((a, i) => console.log(`    ${i + 1}. ${a}`));
    console.log('');
    const pick = await askFn(`  Pick 1–${accounts.length}, or enter a new email to add: `);
    const n = parseInt(pick, 10);
    if (n >= 1 && n <= accounts.length) {
      account = accounts[n - 1];
    } else if (pick.includes('@')) {
      console.log('');
      const authResult = spawnSync('gog', ['auth', 'add', pick], { stdio: 'inherit' });
      if (authResult.status !== 0) {
        return { ok: false, message: 'Google sign-in failed or was skipped.' };
      }
      account = pick;
    } else {
      account = accounts[0];
    }
  }

  config.skills = config.skills || {};
  config.skills.gog = config.skills.gog || {};
  config.skills.gog.account = account;
  console.log(`  ✓ Google account set: ${account}`);
  return { ok: true };
}

function needsGoogleSetup(enableList) {
  return enableList.some((id) => ['gog', 'gmail', 'calendar'].includes(id));
}

function applySkillConfig(skillId, config, env) {
  config.skills = config.skills || {};
  if (skillId === 'home-assistant') {
    config.skills['home-assistant'] = config.skills['home-assistant'] || {};
  } else if (skillId === 'speech') {
    config.skills.speech = config.skills.speech || {};
    config.skills.speech.whisper = config.skills.speech.whisper || {};
    config.skills.speech.elevenLabs = config.skills.speech.elevenLabs || {};
    config.skills.speech.whisper.apiKey = env.SPEECH_WHISPER_API_KEY ? 'SPEECH_WHISPER_API_KEY' : 'LLM_1_API_KEY';
    if (env.ELEVEN_LABS_API_KEY) config.skills.speech.elevenLabs.apiKey = 'ELEVEN_LABS_API_KEY';
    if (env.ELEVEN_LABS_VOICE_ID) config.skills.speech.elevenLabs.voiceId = env.ELEVEN_LABS_VOICE_ID;
  } else if (skillId === 'search') {
    config.skills.search = config.skills.search || {};
    if (env.BRAVE_API_KEY) config.skills.search.apiKey = 'BRAVE_API_KEY';
  }
}

/**
 * Run the install flow for a skill: ensure enabled, prompt for credentials, write state.
 * @param {string} rawSkillId - User input (e.g. "google", "github")
 * @param {string} installDir - CowCode install root
 * @param {{ ask?: Function, promptSecret?: Function }} [deps] - inject for tests
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runSkillInstall(rawSkillId, installDir, deps = {}) {
  const askFn = deps.ask || ask;
  const promptSecretFn = deps.promptSecret || promptSecret;

  if (!rawSkillId) {
    return { ok: false, message: 'Skill id is required. Example: cowcode add github' };
  }

  const skillId = normalizeSkillId(rawSkillId);
  const enableList = getSkillsToEnable(rawSkillId, skillId);

  if (!skillExists(installDir, skillId)) {
    return {
      ok: false,
      message: `Skill "${skillId}" not found. Check the id (e.g. github, google, speech) and that cowCode is installed correctly.`,
    };
  }

  const meta = SKILL_INSTALL_PROMPTS[skillId];

  ensureStateDir();
  const configPath = getConfigPath();
  let config = {};
  try {
    if (existsSync(configPath)) {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    return { ok: false, message: `Could not read config: ${e && e.message}` };
  }

  const enabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : [];
  const alreadyEnabled = enableList.every((id) => enabled.includes(id));

  const envPath = getEnvPath();
  const envContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(envContent);

  const label = meta?.prompt || (skillId === 'github' ? 'GitHub' : skillId === 'gog' ? 'Google Workspace' : skillId);
  console.log('');
  console.log(`Installing skill: ${label}`);
  if (alreadyEnabled) {
    console.log('  (already enabled; will update credentials if you provide new values)');
  }
  console.log('');

  if (skillId === 'github') {
    const result = await setupGithub(config, { ask: askFn, promptSecret: promptSecretFn });
    if (!result.ok) return result;
  } else if (needsGoogleSetup(enableList)) {
    const result = await setupGoogle(config, { ask: askFn, promptSecret: promptSecretFn });
    if (!result.ok) return result;
  }

  if (meta?.envVars?.length) {
    for (const { name, prompt: p } of meta.envVars) {
      const current = env[name] || '';
      const isSecret = /key|token|secret/i.test(name);
      let value;
      if (isSecret) {
        value = await promptSecretFn(`  ${p}`, current);
      } else {
        const promptText = current
          ? `  ${p} [${current.slice(0, 20)}${current.length > 20 ? '…' : ''}]: `
          : `  ${p}: `;
        value = await askFn(promptText);
      }
      if (value !== '') env[name] = value;
    }
    writeFileSync(envPath, stringifyEnv(env), 'utf8');
    console.log('  ✓ Saved credentials.');
  }

  config.skills = config.skills || {};
  const nextEnabled = [...enabled];
  for (const id of enableList) {
    if (!nextEnabled.includes(id)) {
      nextEnabled.push(id);
      console.log(`  ✓ Enabled ${id}.`);
    }
  }
  config.skills.enabled = nextEnabled;

  for (const id of enableList) {
    applySkillConfig(id, config, env);
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  console.log('  ✓ Config updated.');

  console.log('');
  console.log('Done. Restart the bot (cowcode restart) to use the skill.');
  return { ok: true, message: `${normalizeSkillId(rawSkillId)} installed.` };
}
