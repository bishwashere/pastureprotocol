/**
 * Policy-gated command execution.
 *
 * This is intentionally separate from go-read/go-write: those are stable
 * primitives, while exec is the escape hatch for package managers, generators,
 * build tools, and one-off CLIs.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getConfigPath } from '../../util/paths.js';
import { expandTilde } from './run-allowlisted.js';
import { spawnWithTimeout } from './spawn-with-timeout.js';

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MAX_OUTPUT_CHARS = 50_000;
const DEFAULT_ALLOWLIST = ['npm', 'pnpm', 'npx', 'node', 'git'];
const DANGEROUS_ENV_NAMES = new Set([
  'PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
]);

function readConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalizeMode(value) {
  const mode = String(value || 'allowlist').trim().toLowerCase();
  return mode === 'full' ? 'full' : 'allowlist';
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function getExecConfig() {
  const cfg = readConfig();
  const skillCfg = cfg?.skills?.exec && typeof cfg.skills.exec === 'object'
    ? cfg.skills.exec
    : {};
  const pathPrepend = normalizeStringList(skillCfg.pathPrepend);
  if (pathPrepend.length === 0) {
    if (process.platform === 'darwin') pathPrepend.push('/opt/homebrew/bin', '/usr/local/bin');
    if (process.platform === 'linux') pathPrepend.push('/usr/local/bin');
  }
  const allowlist = normalizeStringList(skillCfg.allowlist);
  return {
    mode: normalizeMode(skillCfg.mode),
    allowlist: allowlist.length ? allowlist : DEFAULT_ALLOWLIST,
    pathPrepend,
    timeoutMs: Number.isFinite(Number(skillCfg.timeoutMs))
      ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Number(skillCfg.timeoutMs)))
      : DEFAULT_TIMEOUT_MS,
  };
}

function commandName(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]/);
  return parts[parts.length - 1] || raw;
}

function validateCommand(command, mode, allowlist) {
  const raw = String(command || '').trim();
  if (!raw) return { ok: false, error: 'command is required.' };
  if (/\s/.test(raw)) {
    return {
      ok: false,
      error: 'command must be one executable name or path; put arguments in argv.',
    };
  }
  if (mode === 'full') return { ok: true, command: raw };
  if (!/^[A-Za-z0-9._+-]+$/.test(raw)) {
    return {
      ok: false,
      error: 'allowlist mode only accepts bare executable names.',
    };
  }
  const allowed = new Set(allowlist.map((item) => String(item).trim()).filter(Boolean));
  if (!allowed.has(raw) && !allowed.has(commandName(raw))) {
    return {
      ok: false,
      error: `Command not allowlisted for exec: ${raw}.`,
    };
  }
  return { ok: true, command: raw };
}

function normalizeEnv(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const name = String(key || '').trim();
    if (!name || DANGEROUS_ENV_NAMES.has(name) || /^LD_|^DYLD_/i.test(name)) continue;
    out[name] = String(value ?? '');
  }
  return out;
}

function buildEnv(pathPrepend, extraEnv) {
  const prefix = pathPrepend.map(expandTilde).filter(Boolean).join(':');
  const currentPath = process.env.PATH || '';
  const PATH = prefix ? `${prefix}:${currentPath}` : currentPath;
  return {
    ...process.env,
    ...normalizeEnv(extraEnv),
    PATH,
  };
}

function outputOrJson(result, command) {
  const trim = (text) => {
    const s = String(text || '').trim();
    return s.length <= MAX_OUTPUT_CHARS ? s : s.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
  };
  const stdout = trim(result.stdout);
  const stderr = trim(result.stderr);
  if (result.ok) return stdout || stderr || 'OK';
  return JSON.stringify({
    error: result.error || stderr || stdout || `${command} exited with code ${result.code}`,
    code: result.code,
    stdout: stdout || undefined,
    stderr: stderr || undefined,
    timedOut: result.timedOut || undefined,
  });
}

/**
 * @param {object} ctx
 * @param {object} args
 * @returns {Promise<string>}
 */
export async function executeExec(ctx, args = {}) {
  const config = getExecConfig();
  const validation = validateCommand(args.command || args.action, config.mode, config.allowlist);
  if (!validation.ok) return JSON.stringify({ error: validation.error });

  const argv = Array.isArray(args.argv) ? args.argv.map((item) => String(item)) : [];
  const cwd = args.cwd
    ? resolve(expandTilde(String(args.cwd)))
    : (ctx?.workspaceDir || process.cwd());
  const requestedTimeout = Number(args.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1_000, Math.min(MAX_TIMEOUT_MS, requestedTimeout))
    : config.timeoutMs;
  const env = buildEnv(config.pathPrepend, args.env);

  const result = await spawnWithTimeout(validation.command, argv, {
    cwd,
    env,
    timeoutMs,
    maxOutputChars: MAX_OUTPUT_CHARS,
  });
  return outputOrJson(result, validation.command);
}
