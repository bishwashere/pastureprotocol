/**
 * Install/update build id (git short SHA). Written to BUILD at install/update;
 * dev clones fall back to `git rev-parse --short HEAD`.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export const BUILD_FILE = 'BUILD';

/**
 * @param {string} root - Pasture Protocol install root
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

const REPO_URL = 'https://github.com/bishwashere/cowCode.git';

/**
 * Latest commit on branch via git ls-remote (no GitHub API quota).
 * @param {string} [branch]
 * @returns {string | null}
 */
export function fetchRemoteBuildSync(branch = 'master') {
  try {
    const out = execSync(`git ls-remote ${REPO_URL} refs/heads/${branch}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 20000,
    }).trim();
    const sha = out.split(/\s+/)[0];
    return sha && /^[0-9a-f]+$/i.test(sha) ? sha.slice(0, 7) : null;
  } catch {
    return null;
  }
}

/**
 * Latest commit on branch (short SHA).
 * @param {string} [branch]
 * @returns {Promise<string | null>}
 */
export async function fetchRemoteBuild(branch = 'master') {
  const ref = encodeURIComponent(branch);
  const url = `https://api.github.com/repos/bishwashere/pastureprotocol/commits/${ref}`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pasture-update',
      },
    });
    if (res.ok) {
      const data = await res.json();
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (sha) return sha.slice(0, 7);
    }
  } catch (_) {}
  return fetchRemoteBuildSync(branch);
}

/**
 * @param {string} root
 * @param {string} build
 */
export function writeBuild(root, build) {
  if (!build) return;
  writeFileSync(join(root, BUILD_FILE), `${build}\n`, 'utf8');
}
