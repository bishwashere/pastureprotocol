/**
 * Atomic JSON write: serialize, write to a sibling temp file, then rename
 * over the target. POSIX `rename(2)` is atomic on the same filesystem, so a
 * concurrent reader (e.g. the dashboard process reading the daemon's state
 * file) can never observe a half-written file.
 *
 * Used by stores that are touched by more than one Node process — primarily
 * `agent-context-state.json` and `background-tasks.json`.
 *
 * Lost-update protection across processes still requires a real file lock
 * (proper-lockfile / flock). This helper only solves the torn-read class of
 * race surfaced by audit findings #15 / #16.
 */

import { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, chmodSync } from 'fs';
import { dirname } from 'path';

/**
 * Write `payload` to `path` atomically. The directory is created if missing.
 * On failure, any temp file is cleaned up; the original target is unchanged.
 *
 * @param {string} path - absolute file path
 * @param {string} payload - already-serialized text
 * @param {{ mode?: number, dirMode?: number }} [options] - Optional POSIX
 * permissions. Omitted by existing callers, preserving the historical behavior.
 */
export function writeFileAtomic(path, payload, options = {}) {
  const dir = dirname(path);
  const mode = Number.isInteger(options?.mode) ? options.mode : undefined;
  const dirMode = Number.isInteger(options?.dirMode) ? options.dirMode : undefined;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, ...(dirMode != null ? { mode: dirMode } : {}) });
  if (dirMode != null) chmodSync(dir, dirMode);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, payload, { encoding: 'utf8', ...(mode != null ? { mode } : {}) });
    renameSync(tmp, path);
    if (mode != null) chmodSync(path, mode);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
}

/**
 * Convenience wrapper for the common `JSON.stringify(obj, null, 2)` pattern.
 *
 * @param {string} path
 * @param {object} obj
 * @param {{ mode?: number, dirMode?: number }} [options]
 */
export function writeJsonAtomic(path, obj, options = {}) {
  writeFileAtomic(path, JSON.stringify(obj, null, 2), options);
}
