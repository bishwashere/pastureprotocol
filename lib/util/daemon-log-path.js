import { appendFileSync, existsSync, linkSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getStateDir } from './paths.js';

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getDaemonLogDir(stateDir = getStateDir()) {
  return join(stateDir, 'daily-logs', 'runtime');
}

export function getDailyDaemonLogPath(stateDir = getStateDir(), date = new Date()) {
  return join(getDaemonLogDir(stateDir), `${localDateKey(date)}.log`);
}

export function getDailyDaemonErrPath(stateDir = getStateDir(), date = new Date()) {
  return join(getDaemonLogDir(stateDir), `${localDateKey(date)}.err`);
}

export function getCurrentDaemonLogPath(stateDir = getStateDir()) {
  return join(getDaemonLogDir(stateDir), 'current.log');
}

export function getCurrentDaemonErrPath(stateDir = getStateDir()) {
  return join(getDaemonLogDir(stateDir), 'current.err');
}

function refreshSymlink(linkPath, targetName, targetPath) {
  try {
    try {
      unlinkSync(linkPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    symlinkSync(targetName, linkPath);
  } catch (_) {
    if (process.platform !== 'win32') return;
    try {
      if (targetPath && !existsSync(targetPath)) appendFileSync(targetPath, '', 'utf8');
      if (targetPath) linkSync(targetPath, linkPath);
      return;
    } catch (_) {
      // Windows symlink/hardlink creation can be blocked by policy or cross-device
      // state dirs. Keep a real current.* file so documented paths still exist.
    }
    try {
      appendFileSync(linkPath, '', 'utf8');
    } catch (_) {}
  }
}

export function ensureDailyDaemonLogFiles(stateDir = getStateDir(), date = new Date()) {
  const dir = getDaemonLogDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const day = localDateKey(date);
  const logPath = join(dir, `${day}.log`);
  const errPath = join(dir, `${day}.err`);
  refreshSymlink(join(dir, 'current.log'), `${day}.log`, logPath);
  refreshSymlink(join(dir, 'current.err'), `${day}.err`, errPath);
  return {
    dir,
    logPath,
    errPath,
  };
}
