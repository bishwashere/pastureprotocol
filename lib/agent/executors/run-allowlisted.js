/**
 * Shared runner for allowlisted shell commands. Used by go-read and go-write.
 */

import { spawn } from 'child_process';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
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

function jsonError(error, extra = {}) {
  return JSON.stringify({ error, ...extra });
}

function nonFlagArgs(argv) {
  return argv.filter((a) => !String(a).startsWith('-'));
}

function winPath(cwd, p) {
  if (!p || p === '.') return cwd;
  return resolve(cwd, p);
}

function statSize(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path)) {
    total += statSize(join(path, entry));
  }
  return total;
}

function listRecursive(path, out = []) {
  const st = statSync(path);
  out.push(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      listRecursive(join(path, entry), out);
    }
  }
  return out;
}

function copyOne(src, dest, recursive) {
  const st = statSync(src);
  if (st.isDirectory()) {
    if (!recursive) throw new Error(`${src} is a directory; use -r to copy directories`);
    cpSync(src, dest, { recursive: true, force: true });
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

function runWindowsAllowlisted(cwd, cmd, argv, args = {}) {
  try {
    switch (cmd) {
      case 'pwd':
        return cwd;

      case 'cd': {
        const target = winPath(cwd, nonFlagArgs(argv)[0] || cwd);
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          return jsonError(`Directory not found: ${target}`);
        }
        return target;
      }

      case 'ls': {
        const target = winPath(cwd, nonFlagArgs(argv)[0] || cwd);
        if (!existsSync(target)) return jsonError(`Path not found: ${target}`);
        const st = statSync(target);
        return st.isDirectory() ? readdirSync(target).join('\n') : basename(target);
      }

      case 'cat':
      case 'less': {
        const files = nonFlagArgs(argv);
        if (!files.length) return jsonError(`${cmd} requires at least one file`);
        return limitOutput(files.map((p) => readFileSync(winPath(cwd, p), 'utf8')).join('\n'));
      }

      case 'find': {
        const target = winPath(cwd, nonFlagArgs(argv)[0] || cwd);
        if (!existsSync(target)) return jsonError(`Path not found: ${target}`);
        return limitOutput(listRecursive(target).join('\n'));
      }

      case 'du': {
        const targets = nonFlagArgs(argv);
        const paths = targets.length ? targets : ['.'];
        return paths.map((p) => {
          const target = winPath(cwd, p);
          return `${statSize(target)}\t${target}`;
        }).join('\n');
      }

      case 'mkdir': {
        const recursive = argv.includes('-p');
        const dirs = nonFlagArgs(argv);
        if (!dirs.length) return jsonError('mkdir requires at least one directory');
        for (const p of dirs) mkdirSync(winPath(cwd, p), { recursive });
        return 'OK';
      }

      case 'touch': {
        const files = nonFlagArgs(argv);
        if (!files.length) return jsonError('touch requires at least one file');
        const now = new Date();
        for (const p of files) {
          const target = winPath(cwd, p);
          if (existsSync(target)) {
            utimesSync(target, now, now);
          } else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, '', 'utf8');
          }
        }
        return 'OK';
      }

      case 'rm': {
        const recursive = argv.some((a) => /^-[a-z]*r/i.test(a));
        const force = argv.some((a) => /^-[a-z]*f/i.test(a));
        const targets = nonFlagArgs(argv);
        if (!targets.length) return jsonError('rm requires at least one path');
        for (const p of targets) rmSync(winPath(cwd, p), { recursive, force });
        return 'OK';
      }

      case 'cp': {
        const recursive = argv.some((a) => /^-[a-z]*r/i.test(a)) || args?.fullCopy === true;
        const paths = nonFlagArgs(argv);
        if (paths.length < 2) return jsonError('cp requires source and destination');
        const destRaw = paths[paths.length - 1];
        const sources = paths.slice(0, -1);
        const dest = winPath(cwd, destRaw);
        if (sources.length > 1 && (!existsSync(dest) || !statSync(dest).isDirectory())) {
          return jsonError('cp with multiple sources requires a destination directory');
        }
        for (const srcRaw of sources) {
          const src = winPath(cwd, srcRaw);
          const finalDest = sources.length > 1 || (existsSync(dest) && statSync(dest).isDirectory())
            ? join(dest, basename(src))
            : dest;
          copyOne(src, finalDest, recursive);
        }
        return 'OK';
      }

      case 'mv': {
        const paths = nonFlagArgs(argv);
        if (paths.length < 2) return jsonError('mv requires source and destination');
        const dest = winPath(cwd, paths[paths.length - 1]);
        const sources = paths.slice(0, -1);
        if (sources.length > 1 && (!existsSync(dest) || !statSync(dest).isDirectory())) {
          return jsonError('mv with multiple sources requires a destination directory');
        }
        for (const srcRaw of sources) {
          const src = winPath(cwd, srcRaw);
          const finalDest = sources.length > 1 || (existsSync(dest) && statSync(dest).isDirectory())
            ? join(dest, basename(src))
            : dest;
          mkdirSync(dirname(finalDest), { recursive: true });
          renameSync(src, finalDest);
        }
        return 'OK';
      }

      case 'chmod': {
        const paths = nonFlagArgs(argv);
        if (paths.length < 2) return jsonError('chmod requires mode and at least one path');
        const mode = Number.parseInt(paths[0], 8);
        if (!Number.isFinite(mode)) return jsonError(`Invalid chmod mode: ${paths[0]}`);
        for (const p of paths.slice(1)) chmodSync(winPath(cwd, p), mode);
        return 'OK';
      }

      case 'rsync':
        return jsonError('rsync is not available through the native Windows command adapter.');

      default:
        return jsonError(`Command not implemented on native Windows: ${cmd}`);
    }
  } catch (err) {
    return jsonError(err?.message || String(err));
  }
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

  if (process.platform === 'win32') {
    return runWindowsAllowlisted(cwd, cmd, argv, args);
  }

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
