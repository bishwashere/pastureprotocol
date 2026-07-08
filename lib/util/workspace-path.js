/**
 * Resolve user-facing paths like "workspace/foo.txt" against ctx.workspaceDir.
 */

import { isAbsolute, join, resolve } from 'path';

/**
 * @param {string} workspaceDir
 * @param {string} pathArg
 * @returns {{ resolved: string, pathArg: string }}
 */
export function resolveWorkspacePath(workspaceDir, pathArg) {
  const trimmed = String(pathArg || '').trim();
  if (!trimmed) return { resolved: '', pathArg: trimmed };
  if (isAbsolute(trimmed)) return { resolved: trimmed, pathArg: trimmed };
  const rel = trimmed.replace(/^\.?\/?workspace\/+/, '');
  return { resolved: resolve(join(workspaceDir || '', rel)), pathArg: trimmed };
}
