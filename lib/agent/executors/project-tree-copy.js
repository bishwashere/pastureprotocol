/**
 * Recursive directory copies default to skipping dependency trees and common caches
 * (node_modules, .git, build outputs, etc.). Full tree: pass fullCopy: true or
 * argv flag --pasture-full-copy before other cp flags.
 */

import { existsSync, statSync, mkdirSync } from 'fs';
import { resolve, join, basename, dirname } from 'path';
import { execFileSync } from 'child_process';

/** Match common tooling noise; user can fullCopy to include everything. */
export const PROJECT_TREE_COPY_EXCLUDES = [
  'node_modules',
  '.git',
  '.cursor',
  '/verify',
  '.hg',
  '.svn',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'dist',
  'build',
  'target',
  '.gradle',
  '.idea',
  '.pnpm-store',
  '.yarn/cache',
  'Pods',
  'DerivedData',
  '.pasture',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.npm',
  '.parcel-cache',
];

export const PROJECT_TREE_FULL_COPY_FLAG = '--pasture-full-copy';

let rsyncChecked = false;
let rsyncOk = false;

function rsyncAvailable() {
  if (!rsyncChecked) {
    rsyncChecked = true;
    try {
      execFileSync('rsync', ['--version'], { stdio: 'ignore' });
      rsyncOk = true;
    } catch {
      rsyncOk = false;
    }
  }
  return rsyncOk;
}

function cpArgvHasRecursive(flags) {
  for (const f of flags) {
    if (f === '-R' || f === '-r' || f === '--recursive') return true;
    if (f === '-a' || f === '--archive') return true;
    if (f.startsWith('-') && f.length > 1 && !f.startsWith('--')) {
      const body = f.slice(1);
      if (body.includes('a') || body.includes('r')) return true;
    }
  }
  return false;
}

function parseCpFlagsAndPaths(argv) {
  const flags = [];
  const paths = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') {
      paths.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      flags.push(a);
      i += 1;
      continue;
    }
    paths.push(a);
    i += 1;
  }
  return { flags, paths };
}

/**
 * If this is `cp -r` (or -a) of a single directory, return rsync invocation; else null.
 * @param {string} cwd
 * @param {string[]} argv - arguments after `cp` (expanded paths)
 * @param {{ fullCopy?: boolean }} opts
 * @returns {{ cmd: string, argv: string[] } | null}
 */
export function resolveProjectTreeCopy(cwd, argv, opts = {}) {
  if (!rsyncAvailable() || !Array.isArray(argv) || argv.length < 2) return null;

  let fullCopy = opts.fullCopy === true;
  const cleaned = argv.filter((a) => {
    if (a === PROJECT_TREE_FULL_COPY_FLAG) {
      fullCopy = true;
      return false;
    }
    return true;
  });
  if (fullCopy) return null;

  const { flags, paths } = parseCpFlagsAndPaths(cleaned);
  if (!cpArgvHasRecursive(flags)) return null;
  if (paths.length < 2) return null;

  const dest = paths[paths.length - 1];
  const sources = paths.slice(0, -1);
  if (sources.length !== 1) return null;

  const src = sources[0];
  const srcAbs = resolve(cwd, src);
  if (!existsSync(srcAbs)) return null;
  let st;
  try {
    st = statSync(srcAbs);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  const destAbs = resolve(cwd, dest);
  const excludeArgs = PROJECT_TREE_COPY_EXCLUDES.flatMap((ex) => ['--exclude', ex]);

  let rsyncSrc;
  let rsyncDest;

  if (existsSync(destAbs)) {
    let dstSt;
    try {
      dstSt = statSync(destAbs);
    } catch {
      return null;
    }
    if (!dstSt.isDirectory()) return null;
    const inner = join(destAbs, basename(srcAbs));
    mkdirSync(inner, { recursive: true });
    rsyncSrc = `${srcAbs.replace(/\/?$/, '/')}`;
    rsyncDest = `${inner.replace(/\/?$/, '/')}`;
  } else {
    try {
      mkdirSync(dirname(destAbs), { recursive: true });
      mkdirSync(destAbs, { recursive: true });
    } catch {
      return null;
    }
    rsyncSrc = `${srcAbs.replace(/\/?$/, '/')}`;
    rsyncDest = `${destAbs.replace(/\/?$/, '/')}`;
  }

  return {
    cmd: 'rsync',
    argv: ['-a', ...excludeArgs, rsyncSrc, rsyncDest],
  };
}
