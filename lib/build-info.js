/**
 * Install/update build id (git short SHA). Written to BUILD at install/update;
 * dev clones fall back to `git rev-parse --short HEAD`.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export const BUILD_FILE = 'BUILD';

/**
 * @param {string} root - cowCode install root
 * @returns {string | null}
 */
export function readBuild(root) {
  const buildPath = join(root, BUILD_FILE);
  if (existsSync(buildPath)) {
    const raw = readFileSync(buildPath, 'utf8').trim();
    return raw || null;
  }
  if (existsSync(join(root, '.git'))) {
    try {
      return execSync('git rev-parse --short HEAD', { cwd: root, encoding: 'utf8' }).trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {string | null | undefined} version - semver without leading v
 * @param {string | null | undefined} build
 * @returns {string}
 */
export function formatVersionLabel(version, build) {
  const ver = (version || '').replace(/^v/, '');
  const base = ver ? `v${ver}` : '';
  if (build) {
    return base ? `${base} (${build})` : `(${build})`;
  }
  return base;
}

/**
 * Latest commit on branch (short SHA).
 * @param {string} [branch]
 * @returns {Promise<string | null>}
 */
export async function fetchRemoteBuild(branch = 'master') {
  const ref = encodeURIComponent(branch);
  const url = `https://api.github.com/repos/bishwashere/cowCode/commits/${ref}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'cowcode-update',
    },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const sha = typeof data.sha === 'string' ? data.sha : '';
  return sha ? sha.slice(0, 7) : null;
}

/**
 * @param {string} root
 * @param {string} build
 */
export function writeBuild(root, build) {
  if (!build) return;
  writeFileSync(join(root, BUILD_FILE), `${build}\n`, 'utf8');
}
