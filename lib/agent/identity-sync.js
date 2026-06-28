import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { getAgentWorkspaceDir, getWorkspaceDir } from '../util/paths.js';

export const MAIN_AGENT_ID = 'main';
export const MAIN_SYNCED_IDENTITY_FILES = new Set(['WhoAmI.md']);

export function syncMainAgentIdentityFileFromWorkspace(fileName) {
  if (!MAIN_SYNCED_IDENTITY_FILES.has(fileName)) return { ok: false, skipped: true, reason: 'not_synced_file' };
  const sourcePath = join(getWorkspaceDir(), fileName);
  if (!existsSync(sourcePath)) return { ok: false, skipped: true, reason: 'source_missing' };

  const content = readFileSync(sourcePath, 'utf8');
  const targetPath = join(getAgentWorkspaceDir(MAIN_AGENT_ID), fileName);
  const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  if (current === content) return { ok: true, changed: false, sourcePath, targetPath };

  const targetDir = dirname(targetPath);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  writeFileSync(targetPath, content, 'utf8');
  return { ok: true, changed: true, sourcePath, targetPath };
}

export function syncMainAgentIdentityFromWorkspace() {
  const results = [];
  for (const fileName of MAIN_SYNCED_IDENTITY_FILES) {
    results.push(syncMainAgentIdentityFileFromWorkspace(fileName));
  }
  return results;
}
