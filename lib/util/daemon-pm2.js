/**
 * Windows daemon control via pm2 (no bash required).
 * Used by cli.js on win32 for start | stop | status | restart.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getStateDir } from './paths.js';
import { ensureDailyDaemonLogFiles } from './daemon-log-path.js';

const PM2_NAME = 'pasture';

function quoteWindowsShellArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function pm2ShellArgs(args) {
  return process.platform === 'win32' ? args.map(quoteWindowsShellArg) : args;
}

function pm2Args(args, env) {
  return spawnSync('pm2', pm2ShellArgs(args), {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
}

function pm2Describe(env) {
  return spawnSync('pm2', pm2ShellArgs(['describe', PM2_NAME, '--no-color']), {
    encoding: 'utf8',
    env,
    shell: process.platform === 'win32',
  });
}

/** Append a control line to today's daemon log (same as daemon.sh). */
export function daemonLog(stateDir, action) {
  try {
    const { logPath } = ensureDailyDaemonLogFiles(stateDir);
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '');
    appendFileSync(logPath, `[${stamp}] pasture ${action}\n`, 'utf8');
  } catch (_) {}
}

/** Install pm2 globally if missing. Returns true when pm2 is available. */
export function ensurePm2() {
  const which = spawnSync('pm2', ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (which.status === 0) return true;

  console.log('pm2 not found. It is required to manage the Pasture Protocol daemon on Windows.');
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', stdio: 'pipe', shell: true });
  if (npm.status !== 0) {
    console.error('Error: npm is not installed or not in PATH.');
    console.error('Install pm2 manually: npm install -g pm2');
    return false;
  }

  console.log('Attempting to install pm2 globally: npm install -g pm2');
  const install = spawnSync('npm', ['install', '-g', 'pm2'], { stdio: 'inherit', shell: true });
  if (install.status !== 0) {
    console.error('Error: failed to install pm2. Run as Administrator or install manually:');
    console.error('  npm install -g pm2');
    return false;
  }
  return true;
}

/**
 * Run pm2 daemon action. Returns exit code.
 * @param {'start'|'stop'|'status'|'restart'} action
 * @param {{ installDir: string, stateDir?: string }} opts
 */
export function runPm2DaemonAction(action, opts) {
  const installDir = opts.installDir;
  const stateDir = opts.stateDir || getStateDir();
  const indexJs = join(installDir, 'index.js');
  let dailyLogPath = '';
  let dailyErrPath = '';

  if (!existsSync(indexJs)) {
    console.error(`Missing ${indexJs}. Re-run the installer.`);
    return 1;
  }

  if (!ensurePm2()) return 1;

  mkdirSync(stateDir, { recursive: true });
  try {
    const { logPath, errPath } = ensureDailyDaemonLogFiles(stateDir);
    dailyLogPath = logPath;
    dailyErrPath = errPath;
    appendFileSync(logPath, '', 'utf8');
    appendFileSync(errPath, '', 'utf8');
  } catch (_) {}

  const env = {
    ...process.env,
    PASTURE_INSTALL_DIR: installDir,
    PASTURE_STATE_DIR: stateDir,
  };

  switch (action) {
    case 'start': {
      const desc = pm2Describe(env);
      if (desc.status === 0 && desc.stdout?.includes('status')) {
        console.log('Daemon is already running. Logs: pm2 logs pasture');
        daemonLog(stateDir, 'start');
        return 0;
      }
      const startArgs = ['start', indexJs, '--name', PM2_NAME, '--cwd', installDir];
      if (dailyLogPath && dailyErrPath) {
        startArgs.push('--output', dailyLogPath, '--error', dailyErrPath);
      }
      const r = pm2Args(startArgs, env);
      if (r.status === 0) {
        console.log('Started with pm2. To see logs: pasture logs');
        daemonLog(stateDir, 'start');
      }
      return r.status ?? 1;
    }
    case 'stop': {
      const r = pm2Args(['stop', PM2_NAME], env);
      if (r.status === 0) {
        console.log('Daemon stopped.');
        daemonLog(stateDir, 'stop');
      }
      return r.status ?? 1;
    }
    case 'restart': {
      const desc = pm2Describe(env);
      if (desc.status !== 0) {
        const startArgs = ['start', indexJs, '--name', PM2_NAME, '--cwd', installDir];
        if (dailyLogPath && dailyErrPath) {
          startArgs.push('--output', dailyLogPath, '--error', dailyErrPath);
        }
        const r = pm2Args(startArgs, env);
        if (r.status === 0) daemonLog(stateDir, 'restart');
        return r.status ?? 1;
      }
      const r = pm2Args(['restart', PM2_NAME], env);
      if (r.status === 0) {
        console.log('Daemon restarted.');
        daemonLog(stateDir, 'restart');
      }
      return r.status ?? 1;
    }
    case 'status': {
      const r = pm2Args(['status', PM2_NAME], env);
      if (r.status !== 0) console.log('Daemon is not running.');
      return r.status ?? 1;
    }
    default:
      console.error('Usage: pasture start|stop|status|restart');
      return 1;
  }
}

/** Stop and remove pm2 process (for uninstall). */
export function stopPm2ForUninstall() {
  const which = spawnSync('pm2', ['--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (which.status !== 0) return;
  spawnSync('pm2', ['delete', PM2_NAME], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
