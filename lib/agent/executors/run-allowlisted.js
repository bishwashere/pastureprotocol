/**
 * Shared runner for allowlisted shell commands. Used by go-read and go-write.
 */

import { spawn } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { resolveProjectTreeCopy } from './project-tree-copy.js';
import { runRsyncAllowlisted } from './rsync-allowlisted.js';

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

export function expandTilde(str) {
  if (typeof str !== 'string') return str;
  const s = str.trim();
  if (s.startsWith('~/') || s === '~') return join(homedir(), s.slice(1));
  return s;
}

function limitOutput(text) {
  if (!text) return '';
  const out = String(text).trim();
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 * @param {Set<string>} allowed - e.g. new Set(['ls', 'cat', 'pwd'])
 * @returns {Promise<string>}
 */
export async function runAllowlisted(ctx, args, allowed) {
  const cmd = (args?.command || args?.action || '').toString().trim().toLowerCase();
  if (!allowed.has(cmd)) {
    return JSON.stringify({ error: `Command not allowed: ${cmd}. Allowed: ${[...allowed].sort().join(', ')}.` });
  }

  let argv = Array.isArray(args?.argv) ? args.argv.map((a) => String(a)) : [];
  argv = argv.map((a) => expandTilde(a));
  const cwd = args?.cwd ? expandTilde(String(args.cwd)) : (ctx?.workspaceDir || process.cwd());

  if (cmd === 'rsync') {
    return runRsyncAllowlisted(cwd, argv);
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;

    if (cmd === 'cd') {
      const path = argv[0] || cwd;
      child = spawn('sh', ['-c', `cd "${path.replace(/"/g, '\\"')}" && pwd`], { cwd });
    } else if (cmd === 'less') {
      child = spawn(cmd, ['-E', '-X', '-F', ...argv], { cwd });
    } else if (cmd === 'cp') {
      const alt = resolveProjectTreeCopy(cwd, argv, { fullCopy: args?.fullCopy === true });
      if (alt) {
        child = spawn(alt.cmd, alt.argv, { cwd });
      } else {
        child = spawn(cmd, argv, { cwd });
      }
    } else {
      child = spawn(cmd, argv, { cwd });
    }

    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(JSON.stringify({ error: `Command timed out after ${TIMEOUT_MS / 1000}s.` }));
    }, TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve(JSON.stringify({ error: err.message }));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const out = limitOutput(stdout);
      const err = limitOutput(stderr);
      if (code === 0) {
        resolve(out || err || 'OK');
        return;
      }
      resolve(JSON.stringify({ error: err || out || `Exit code ${code}`, stdout: out || undefined, stderr: err || undefined }));
    });
  });
}
