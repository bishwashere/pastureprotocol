/**
 * gog executor: runs gog CLI commands from LLM-provided args.
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { getConfigPath } from '../../util/paths.js';
import { resolveEnvCredential, resolveAccount } from '../../util/credential-utils.js';

const MAX_OUTPUT_CHARS = 16_000;
const ALLOWED_TOP_LEVEL = new Set(['gmail', 'calendar', 'drive', 'contacts', 'sheets', 'docs', 'auth']);

function limitOutput(text) {
  if (!text) return '';
  const out = text.trim();
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
}

function fromEnv(val) {
  return resolveEnvCredential(val);
}

function getDefaultAccount() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    if (!raw || !raw.trim()) return '';
    const config = JSON.parse(raw);
    const account = config?.skills?.gog?.account;
    const resolved = fromEnv(account);
    return resolved && String(resolved).trim() ? String(resolved).trim() : '';
  } catch {
    return '';
  }
}

function normalizeArgv(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) return null;
  const argv = rawArgv.map((v) => String(v)).filter((v) => v.trim().length > 0);
  if (argv.length === 0) return null;
  if (argv[0].toLowerCase() === 'gog') argv.shift();
  if (argv.length === 0) return null;
  return argv;
}

function requiresConfirm(argv) {
  const a0 = (argv[0] || '').toLowerCase();
  const a1 = (argv[1] || '').toLowerCase();
  if (a0 === 'gmail' && a1 === 'send') return true;
  if (a0 === 'calendar' && ['create', 'add', 'insert'].includes(a1)) return true;
  return false;
}

function isAllowed(argv) {
  const a0 = (argv[0] || '').toLowerCase();
  return ALLOWED_TOP_LEVEL.has(a0);
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - LLM tool args (action, argv, account?, confirm?)
 */
export async function executeGog(ctx, args) {
  const action = args?.action && String(args.action).trim().toLowerCase();
  if (!action) throw new Error('action required (run)');
  if (action !== 'run') throw new Error(`Unknown action: ${action}`);

  const argv = normalizeArgv(args?.argv);
  if (!argv) throw new Error('argv is required (array of strings)');
  if (!isAllowed(argv)) throw new Error('Unsupported gog command. Use gmail, calendar, drive, contacts, sheets, docs, or auth.');

  if (requiresConfirm(argv) && args?.confirm !== true) {
    return JSON.stringify({ error: 'Confirmation required. Ask the user to confirm before sending mail or creating calendar events.' });
  }

  const env = { ...process.env };
  // Daemon/launchd often has minimal PATH; ensure gog (e.g. Homebrew) is findable
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const pathPrefix = ['/opt/homebrew/bin', '/usr/local/bin'].join(pathSep);
  env.PATH = pathPrefix + pathSep + (env.PATH || '');

  if (args?.account && String(args.account).trim()) {
    env.GOG_ACCOUNT = resolveAccount(args.account, getDefaultAccount);
  } else if (!env.GOG_ACCOUNT) {
    const fallback = getDefaultAccount();
    if (fallback) env.GOG_ACCOUNT = fallback;
  }

  const cwd = ctx?.workspaceDir || process.cwd();

  return new Promise((resolve) => {
    const child = spawn('gog', argv, { cwd, env });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      resolve(JSON.stringify({ error: err.message }));
    });

    child.on('close', (code) => {
      const out = limitOutput(stdout);
      const err = limitOutput(stderr);
      if (code === 0) {
        resolve(out || err || 'OK');
        return;
      }
      const message = err || out || `gog exited with code ${code}`;
      resolve(JSON.stringify({ error: message }));
    });
  });
}
