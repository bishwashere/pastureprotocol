/**
 * Local rsync only: archive-style copy with optional --exclude= globs (e.g. skip media).
 * No remote hosts, no --exclude-from, no shell injection.
 */

import { spawn, execFileSync } from 'child_process';

export const RSYNC_ALLOWLISTED_TIMEOUT_MS = 600_000; // 10 min for large trees
const MAX_EXCLUDE_RULES = 120;
const MAX_SINGLE_ARG_LEN = 8000;
const MAX_OUTPUT_CHARS = 50_000;

/** Characters that must not appear in paths or exclude patterns. */
const UNSAFE = /[\n\r;|&$`<>\u0000]/;

let rsyncChecked = false;
let rsyncOk = false;

function rsyncOnPath() {
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

function shortFlagsOk(token) {
  if (!token.startsWith('-') || token.startsWith('--')) return false;
  const body = token.slice(1);
  if (!body) return false;
  // archive-related + verbose, human-readable, dry-run
  return /^[avhn]+$/.test(body);
}

function remoteishPath(p) {
  if (p == null || typeof p !== 'string') return true;
  if (p.includes('::')) return true;
  const at = p.indexOf('@');
  if (at >= 0 && p.indexOf(':', at + 1) >= 0) return true;
  if (UNSAFE.test(p)) return true;
  return false;
}

/**
 * @param {string[]} argv - rsync args only (no "rsync" binary name)
 * @returns {{ ok: true, argv: string[] } | { ok: false, error: string }}
 */
export function normalizeRsyncArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    return { ok: false, error: 'rsync needs at least a source path and a destination path.' };
  }
  let excludeCount = 0;
  const flags = [];
  const paths = [];
  for (const raw of argv) {
    const a = String(raw);
    if (a.length > MAX_SINGLE_ARG_LEN) {
      return { ok: false, error: 'Argument too long.' };
    }
    if (a.startsWith('-') && a !== '-') {
      if (a.startsWith('--exclude=')) {
        excludeCount += 1;
        if (excludeCount > MAX_EXCLUDE_RULES) {
          return { ok: false, error: `At most ${MAX_EXCLUDE_RULES} --exclude= rules.` };
        }
        const pat = a.slice('--exclude='.length);
        if (!pat || UNSAFE.test(pat) || pat.length > 400) {
          return { ok: false, error: 'Invalid --exclude= pattern (no shell metacharacters; max 400 chars).' };
        }
        flags.push(`--exclude=${pat}`);
      } else if (shortFlagsOk(a)) {
        flags.push(a);
      } else {
        return {
          ok: false,
          error: `rsync flag not allowed: ${a.slice(0, 48)}. Use short flags a,v,h,n only (e.g. -a, -av) and --exclude=PATTERN.`,
        };
      }
    } else {
      paths.push(a);
    }
  }
  if (paths.length !== 2) {
    return {
      ok: false,
      error: 'rsync requires exactly one source and one destination (local paths only), after flags and excludes.',
    };
  }
  const [src, dest] = paths;
  if (remoteishPath(src) || remoteishPath(dest)) {
    return { ok: false, error: 'Remote rsync is not allowed; use absolute or workspace-relative local paths only.' };
  }
  const hasArchive = flags.some((x) => x.startsWith('-') && !x.startsWith('--') && x.includes('a'));
  const ordered = hasArchive ? [...flags] : ['-a', ...flags];
  return { ok: true, argv: [...ordered, src, dest] };
}

function limitOutput(text) {
  const out = String(text || '').trim();
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
}

/**
 * @param {string} cwd
 * @param {string[]} argv
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<string>}
 */
export function runRsyncAllowlisted(cwd, argv, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? RSYNC_ALLOWLISTED_TIMEOUT_MS;
  if (!rsyncOnPath()) {
    return Promise.resolve(JSON.stringify({ error: 'rsync is not installed or not on PATH.' }));
  }
  const norm = normalizeRsyncArgv(argv);
  if (!norm.ok) {
    return Promise.resolve(JSON.stringify({ error: norm.error }));
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('rsync', norm.argv, { cwd });

    const to = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve(JSON.stringify({ error: `rsync timed out after ${timeoutMs / 1000}s` }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(to);
      resolve(JSON.stringify({ error: err.message }));
    });

    child.on('close', (code) => {
      clearTimeout(to);
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
