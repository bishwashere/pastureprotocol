/**
 * Go write: change the filesystem (cp, mv, rm, touch, chmod, mkdir) and install
 * package dependencies.
 */

import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { expandTilde, runAllowlisted } from './run-allowlisted.js';

const ALLOWED = new Set(['cp', 'mv', 'rm', 'touch', 'chmod', 'mkdir', 'rsync', 'npm', 'pnpm']);
const PACKAGE_MANAGER_WRITE_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 50_000;
const CREATE_NEXT_APP_TIMEOUT_MS = 600_000;

function limitOutput(text) {
  const out = String(text || '').trimEnd();
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
}

export function validatePackageManagerWriteArgs(command, argv) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  const firstNonFlag = args.find((item) => !item.startsWith('-'));
  if (!firstNonFlag) {
    return { ok: false, error: `${command} requires the install subcommand.` };
  }
  if (firstNonFlag.toLowerCase() !== 'install') {
    return { ok: false, error: `${command} subcommand not allowed here: ${firstNonFlag}. Use go-write only for ${command} install.` };
  }
  return { ok: true, argv: args };
}

function booleanArg(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return fallback;
}

function cleanImportAlias(value) {
  const alias = String(value || '@/*').trim() || '@/*';
  if (!/^[A-Za-z0-9_@./*-]+$/.test(alias)) {
    return { ok: false, error: 'importAlias may only contain letters, numbers, _, @, ., /, *, and -.' };
  }
  return { ok: true, alias };
}

function isNonEmptyDirectory(path) {
  return existsSync(path) && readdirSync(path).length > 0;
}

/**
 * Build a strict create-next-app command. This intentionally does not expose
 * arbitrary npx/npm-create execution.
 */
export function validateCreateNextAppArgs(args = {}, ctx = {}) {
  const rawPath = String(args.path || args.projectPath || args.name || '').trim();
  if (!rawPath) return { ok: false, error: 'path is required for create_next_app.' };
  if (rawPath === '/' || rawPath === '~') return { ok: false, error: 'Refusing to scaffold into a root/home directory.' };

  const cwd = args.cwd ? expandTilde(String(args.cwd)) : (ctx?.workspaceDir || process.cwd());
  const expandedPath = expandTilde(rawPath);
  const targetPath = resolve(cwd, expandedPath);
  const targetArg = expandedPath.startsWith('/') ? targetPath : expandedPath;
  if (isNonEmptyDirectory(targetPath)) {
    return { ok: false, error: `Target directory is not empty: ${targetPath}` };
  }

  const packageManager = String(args.packageManager || 'npm').trim().toLowerCase();
  if (!['npm', 'pnpm'].includes(packageManager)) {
    return { ok: false, error: 'packageManager must be npm or pnpm.' };
  }

  const alias = cleanImportAlias(args.importAlias);
  if (!alias.ok) return alias;

  const typescript = booleanArg(args.typescript, true);
  const tailwind = booleanArg(args.tailwind, true);
  const eslint = booleanArg(args.eslint, true);
  const appRouter = booleanArg(args.appRouter, true);
  const srcDir = booleanArg(args.srcDir, false);
  const turbopack = booleanArg(args.turbopack, false);

  const flags = [
    typescript ? '--typescript' : '--javascript',
    tailwind ? '--tailwind' : '',
    eslint ? '--eslint' : '',
    appRouter ? '--app' : '',
    srcDir ? '--src-dir' : '',
    turbopack ? '--turbopack' : '',
    '--import-alias',
    alias.alias,
    packageManager === 'pnpm' ? '--use-pnpm' : '--use-npm',
  ].filter(Boolean);

  const command = packageManager === 'pnpm' ? 'pnpm' : 'npx';
  const argv = packageManager === 'pnpm'
    ? ['dlx', 'create-next-app@latest', targetArg, '--yes', ...flags]
    : ['-y', 'create-next-app@latest', targetArg, '--yes', ...flags];

  return { ok: true, command, argv, cwd, targetPath, packageManager };
}

function executePackageManagerWrite(ctx, args, command) {
  const validation = validatePackageManagerWriteArgs(command, args?.argv);
  if (!validation.ok) return Promise.resolve(JSON.stringify({ error: validation.error }));
  const cwd = args?.cwd ? expandTilde(String(args.cwd)) : (ctx?.workspaceDir || process.cwd());

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, validation.argv, { cwd, shell: false });
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(JSON.stringify({ error: `${command} install timed out after ${PACKAGE_MANAGER_WRITE_TIMEOUT_MS / 1000}s.` }));
    }, PACKAGE_MANAGER_WRITE_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve(JSON.stringify({ error: err.message || String(err) }));
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

function executeCreateNextApp(ctx, args) {
  const validation = validateCreateNextAppArgs(args, ctx);
  if (!validation.ok) return Promise.resolve(JSON.stringify({ error: validation.error }));
  if (args?.dryRun === true) {
    return Promise.resolve(JSON.stringify({
      ok: true,
      dryRun: true,
      command: validation.command,
      argv: validation.argv,
      cwd: validation.cwd,
      targetPath: validation.targetPath,
    }));
  }

  mkdirSync(dirname(validation.targetPath), { recursive: true });
  return new Promise((resolveResult) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(validation.command, validation.argv, { cwd: validation.cwd, shell: false });
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolveResult(JSON.stringify({ error: `create_next_app timed out after ${CREATE_NEXT_APP_TIMEOUT_MS / 1000}s.` }));
    }, CREATE_NEXT_APP_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      resolveResult(JSON.stringify({ error: err.message || String(err) }));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const out = limitOutput(stdout);
      const err = limitOutput(stderr);
      if (code !== 0) {
        resolveResult(JSON.stringify({ error: err || out || `Exit code ${code}`, stdout: out || undefined, stderr: err || undefined }));
        return;
      }
      const packageJsonPath = resolve(validation.targetPath, 'package.json');
      resolveResult(JSON.stringify({
        ok: true,
        created: existsSync(packageJsonPath),
        path: validation.targetPath,
        packageManager: validation.packageManager,
        stdout: out || undefined,
        stderr: err || undefined,
      }));
    });
  });
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 */
export async function executeGoWrite(ctx, args) {
  const action = String(args?.action || args?.command || '').trim().toLowerCase();
  if (action === 'create_next_app') return executeCreateNextApp(ctx, args);
  if (action === 'npm' || action === 'pnpm') return executePackageManagerWrite(ctx, args, action);
  return runAllowlisted(ctx, args, ALLOWED);
}
