#!/usr/bin/env node
/**
 * CLI entry: auth, start/stop/status/restart, update, and skill add/remove.
 * Usage: pasture auth | pasture setup | pasture start|stop|status|restart | pasture logs | pasture add <skill-id> | pasture remove <skill-id> | pasture update [--force]
 */

import { spawn, spawnSync, execSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import readline from 'readline';
import { runPm2DaemonAction } from './lib/util/daemon-pm2.js';
import { runUninstall as runWindowsUninstall } from './lib/util/uninstall-win.js';
import { runPreflight, formatCheckResult } from './lib/util/preflight.js';
import { maybeBeginCliSession, envForNestedCliCall } from './lib/util/cli-banner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = process.env.PASTURE_INSTALL_DIR
  ? resolve(process.env.PASTURE_INSTALL_DIR)
  : __dirname;

const args = process.argv.slice(2);
const sub = args[0];
const isForceUpdate = args.slice(1).some((a) => a === '--force' || a === '-f');

const IS_WIN = process.platform === 'win32';

maybeBeginCliSession(sub, args);

function installHint() {
  if (IS_WIN) {
    console.error('  iwr -useb https://raw.githubusercontent.com/bishwashere/pastureprotocol/master/install.ps1 | iex');
    console.error('  Or: irm https://raw.githubusercontent.com/bishwashere/pastureprotocol/master/install.ps1 | iex');
  } else {
    console.error('  curl -fsSL https://raw.githubusercontent.com/bishwashere/pastureprotocol/master/install.sh | bash');
  }
}

function restartDaemonSync() {
  if (IS_WIN) {
    return runPm2DaemonAction('restart', { installDir: INSTALL_DIR });
  }
  const daemonScript = join(INSTALL_DIR, 'scripts', 'daemon.sh');
  if (!existsSync(daemonScript)) return 1;
  const r = spawnSync('bash', [daemonScript, 'restart'], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  return r.status ?? 1;
}

function restartBotAfterSkillChange() {
  const daemonScript = join(INSTALL_DIR, 'scripts', 'daemon.sh');
  if (IS_WIN || existsSync(daemonScript)) {
    console.log('');
    console.log('Restarting bot to apply skill changes...');
    const code = restartDaemonSync();
    if (code === 0) {
      console.log('  ✓ Bot restarted.');
    } else {
      console.error('  ✗ Auto-restart failed. Run: pasture restart');
    }
  } else {
    console.log('Restart skipped (daemon script not found). Run: pasture restart');
  }
}

async function runSkillCommand(action, skillArg) {
  try {
    const skillInstallPath = join(INSTALL_DIR, 'lib', 'util', 'skill-install.js');
    const mod = await import(pathToFileURL(skillInstallPath).href);
    const result = action === 'remove'
      ? await mod.runSkillRemove(skillArg, INSTALL_DIR)
      : await mod.runSkillInstall(skillArg, INSTALL_DIR);
    if (!result.ok) {
      console.error('pasture:', result.message);
      process.exit(1);
    }
    restartBotAfterSkillChange();
  } catch (err) {
    console.error(`pasture: skills ${action} failed.`, err?.message || err);
    process.exit(1);
  }
}

/** After a successful update: restart the daemon and run dashboard, with clear logging. */
function runPostUpdateRestartAndDashboard() {
  console.log('');
  console.log('  Restarting bot and starting dashboard...');
  const restartCode = restartDaemonSync();
  if (restartCode === 0) {
    console.log('  ✓ Restarted.');
  } else {
    console.error('  ✗ Restart had issues. You can run: pasture restart');
  }
  const serverPath = join(INSTALL_DIR, 'dashboard', 'server.js');
  if (existsSync(serverPath)) {
    const dashResult = spawnSync(process.execPath, [join(INSTALL_DIR, 'cli.js'), 'dashboard'], {
      stdio: 'inherit',
      env: envForNestedCliCall({ ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR }),
      cwd: INSTALL_DIR,
    });
    if (dashResult.status === 0) {
      console.log('  ✓ Dashboard started.');
    } else {
      console.error('  ✗ Dashboard failed to start. You can run: pasture dashboard');
    }
  } else {
    console.log('  (dashboard not found; run pasture dashboard if needed)');
  }

  // Backfill agent avatars in the background — fire-and-forget, never blocks.
  const backfillScript = join(INSTALL_DIR, 'scripts', 'backfill-agent-avatars.js');
  if (existsSync(backfillScript)) {
    const child = spawn(process.execPath, [backfillScript], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
      cwd: INSTALL_DIR,
    });
    child.unref();
  }

  console.log('');
}

function runDaemonAction(action) {
  if (IS_WIN) {
    process.exit(runPm2DaemonAction(action, { installDir: INSTALL_DIR }));
  }
  const script = join(INSTALL_DIR, 'scripts', 'daemon.sh');
  if (!existsSync(script)) {
    console.error('pasture: installation incomplete or corrupted.');
    console.error('  Re-run the installer:');
    installHint();
    process.exit(1);
  }
  const child = spawn('bash', [script, action], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

/**
 * Runtime dependency preflight for `pasture start` / `pasture restart`.
 *
 * Catches "Playwright Chromium binary missing at rev N" and missing cloud LLM
 * keys *before* the daemon comes up. Required deps abort the start; soft
 * issues print as warnings and proceed.
 *
 * Skip with `PASTURE_SKIP_PREFLIGHT=1` (e.g. CI, container init) or when a
 * fatal check has an autoFix and the user is interactive: ask once, run it,
 * re-check, then continue.
 */
async function runStartPreflight(action) {
  if (process.env.PASTURE_SKIP_PREFLIGHT === '1') return;
  console.log(`pasture: preflight checks before ${action}...`);
  let { results, hasFatal } = await runPreflight({ installDir: INSTALL_DIR });
  for (const r of results) console.log(formatCheckResult(r));

  if (!hasFatal) return;

  // Try interactive auto-fix for the first fatal result that exposes one.
  const fixable = results.find((r) => !r.ok && r.severity === 'fatal' && r.autoFix);
  if (fixable && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => {
      rl.question(`\npasture: ${fixable.label} is broken. Run \`${fixable.autoFix.label}\` now? [Y/n] `, res);
    });
    rl.close();
    if (!/^n/i.test(String(answer || '').trim())) {
      const fixResult = spawnSync(fixable.autoFix.command, fixable.autoFix.args, {
        stdio: 'inherit',
        cwd: INSTALL_DIR,
        env: process.env,
      });
      if (fixResult.status !== 0) {
        console.error(`pasture: auto-fix \`${fixable.autoFix.label}\` failed (exit ${fixResult.status}).`);
        process.exit(1);
      }
      ({ results, hasFatal } = await runPreflight({ installDir: INSTALL_DIR }));
      console.log('pasture: re-running preflight...');
      for (const r of results) console.log(formatCheckResult(r));
      if (hasFatal) {
        console.error('pasture: fatal preflight issues remain after auto-fix. Aborting.');
        process.exit(1);
      }
      return;
    }
  }

  console.error('pasture: fatal preflight issues. Refusing to start.');
  console.error('  Set PASTURE_SKIP_PREFLIGHT=1 to bypass (NOT recommended).');
  process.exit(1);
}

if (['start', 'stop', 'status', 'restart'].includes(sub)) {
  if (sub === 'start' || sub === 'restart') {
    (async () => {
      await runStartPreflight(sub);
      runDaemonAction(sub);
    })();
  } else {
    runDaemonAction(sub);
  }
} else if (sub === 'dashboard') {
  (async () => {
    const serverPath = join(INSTALL_DIR, 'dashboard', 'server.js');
    if (!existsSync(serverPath)) {
      console.error('pasture: dashboard not found. Re-run the installer or run from repo.');
      process.exit(1);
    }
    const { DEFAULT_DASHBOARD_HOST, DEFAULT_DASHBOARD_PORT } = await import('./lib/util/dashboard-url.js');
    const port = process.env.PASTURE_DASHBOARD_PORT || String(DEFAULT_DASHBOARD_PORT);
    const host = process.env.PASTURE_DASHBOARD_HOST || DEFAULT_DASHBOARD_HOST;
    const url = `http://${host}:${port}`;
    try {
      const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' });
      const pids = out.trim().split(/\s+/).filter(Boolean);
      if (pids.length) {
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGTERM');
          } catch (_) {}
        }
        const list = pids.length === 1 ? `PID ${pids[0]}` : `PIDs ${pids.join(', ')}`;
        console.log('Stopped previous dashboard (' + list + ').');
        await new Promise((r) => setTimeout(r, 400));
      }
    } catch (_) {
      // No process on port (or lsof not available, e.g. Windows)
    }
    const child = spawn(process.execPath, [serverPath], {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
      cwd: INSTALL_DIR,
    });
    child.unref();
    console.log('Started dashboard at', url);
    console.log('(Refresh the page if you had it open.)');
    setTimeout(() => {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(openCmd, [url], { stdio: 'ignore' }).unref();
    }, 800);
    process.exit(0);
  })();
} else if (sub === 'setup') {
  const setupScript = join(INSTALL_DIR, 'setup.js');
  if (!existsSync(setupScript)) {
    console.error('pasture: setup.js not found. Re-run the installer or run from repo.');
    installHint();
    process.exit(1);
  }
  const child = spawn(process.execPath, [setupScript], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'auth' || (args.length === 1 && args[0] === '--auth-only')) {
  const authArgs = args[0] === '--auth-only' ? args : ['--auth-only', ...args.slice(1)];
  const child = spawn(process.execPath, [join(INSTALL_DIR, 'index.js'), ...authArgs], {
    stdio: 'inherit',
    env: process.env,
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'update') {
  const branch = process.env.PASTURE_BRANCH || 'master';
  const env = {
    ...process.env,
    PASTURE_ROOT: INSTALL_DIR,
    PASTURE_INSTALL_DIR: INSTALL_DIR,
  };

  if (IS_WIN) {
    const psScript = join(INSTALL_DIR, 'update.ps1');
    if (!existsSync(psScript)) {
      console.error('pasture: update.ps1 not found. Re-run the installer.');
      installHint();
      process.exit(1);
    }
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript];
    if (isForceUpdate) psArgs.push('-Force');
    const child = spawn('powershell', psArgs, {
      stdio: 'inherit',
      env,
      cwd: INSTALL_DIR,
    });
    child.on('close', (code) => {
      if (code === 0) runPostUpdateRestartAndDashboard();
      process.exit(code ?? 0);
    });
  } else if (isForceUpdate) {
    // Run latest update.sh from GitHub so --force works even when installed script is old
    const url = `https://raw.githubusercontent.com/bishwashere/pastureprotocol/${branch}/update.sh?t=${Date.now()}`;
    const tmpScript = join(tmpdir(), `pasture-update-${Date.now()}.sh`);
    const curl = spawnSync('curl', ['-fsSL', '-H', 'Cache-Control: no-cache', url, '-o', tmpScript], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (curl.status !== 0) {
      console.error('pasture: failed to fetch update script from GitHub.');
      process.exit(1);
    }
    const child = spawn('bash', [tmpScript, '--force'], {
      stdio: 'inherit',
      env: { ...env, PASTURE_ROOT: INSTALL_DIR },
      cwd: INSTALL_DIR,
    });
    child.on('close', (code) => {
      try {
        unlinkSync(tmpScript);
      } catch (_) {}
      if (code !== 0) {
        process.exit(code);
        return;
      }
      runPostUpdateRestartAndDashboard();
      process.exit(0);
    });
  } else {
    const script = join(INSTALL_DIR, 'update.sh');
    if (!existsSync(script)) {
      console.error('pasture: update.sh not found. Re-run the installer.');
      installHint();
      process.exit(1);
    }
    const child = spawn('bash', [script], {
      stdio: 'inherit',
      env,
      cwd: INSTALL_DIR,
    });
    child.on('close', (code) => {
      if (code === 0) {
        runPostUpdateRestartAndDashboard();
      }
      process.exit(code ?? 0);
    });
  }
} else if (sub === 'avatars') {
  // Generate (or re-generate) missing agent profile pictures.
  const backfillScript = join(INSTALL_DIR, 'scripts', 'backfill-agent-avatars.js');
  if (!existsSync(backfillScript)) {
    console.error('pasture: backfill-agent-avatars.js not found. Re-run the installer.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [backfillScript], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'uninstall') {
  const script = join(INSTALL_DIR, 'uninstall.sh');
  if (!existsSync(script)) {
    console.error('pasture: uninstall.sh not found. Re-run the installer.');
    installHint();
    process.exit(1);
  }
  const child = spawn('bash', [script], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'logs') {
  const stateDir = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');
  const logPath = join(stateDir, 'daemon.log');
  if (process.platform === 'win32') {
    const child = spawn('pm2', ['logs', 'pasture'], {
      stdio: 'inherit',
      env: process.env,
      cwd: INSTALL_DIR,
    });
    child.on('close', (code) => process.exit(code ?? 0));
  } else {
    if (!existsSync(logPath)) {
      console.error('pasture: no log file yet. Start the bot with: pasture start');
      process.exit(1);
    }
    const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 0));
  }
} else if (sub === 'tide') {
  const tideScript = join(INSTALL_DIR, 'scripts', 'tide-cli.js');
  if (!existsSync(tideScript)) {
    console.error('pasture: scripts/tide-cli.js not found.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [tideScript, ...args.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'index') {
  const indexScript = join(INSTALL_DIR, 'scripts', 'index-cli.js');
  if (!existsSync(indexScript)) {
    console.error('pasture: scripts/index-cli.js not found.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [indexScript, ...args.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, PASTURE_STATE_DIR: process.env.PASTURE_STATE_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'create') {
  const kind = (args[1] || '').toLowerCase();
  const name = args.slice(2).join(' ').trim();
  if (kind !== 'agent' || !name) {
    console.log('Usage: pasture create agent <name>');
    console.log('Example: pasture create agent alex');
    process.exit((args[1] || args[2]) ? 1 : 0);
  }
  (async () => {
    try {
      const modPath = join(INSTALL_DIR, 'lib', 'agent-config.js');
      const mod = await import(pathToFileURL(modPath).href);
      const result = mod.createAgent(name);
      if (result.created) {
        console.log('Created agent:', result.id);
      } else {
        console.log('Agent already exists:', result.id);
      }
      console.log('You can assign groups to this agent from Dashboard -> Groups.');
    } catch (err) {
      console.error('pasture: failed to create agent.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'delete') {
  const kind = (args[1] || '').toLowerCase();
  const name = args.slice(2).filter((a) => a !== '--yes' && a !== '-y').join(' ').trim();
  const forceYes = args.includes('--yes') || args.includes('-y');
  if (kind !== 'agent' || !name) {
    console.log('Usage: pasture delete agent <name> [--yes]');
    console.log('Example: pasture delete agent alex');
    process.exit((args[1] || args[2]) ? 1 : 0);
  }
  (async () => {
    try {
      if (!forceYes) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((resolve) => {
          rl.question(`Delete agent "${name}"? Type DELETE to confirm: `, resolve);
        });
        rl.close();
        if (String(answer || '').trim() !== 'DELETE') {
          console.log('Cancelled.');
          process.exit(1);
          return;
        }
      }
      const modPath = join(INSTALL_DIR, 'lib', 'agent-config.js');
      const mod = await import(pathToFileURL(modPath).href);
      const result = mod.deleteAgent(name);
      if (!result.deleted) {
        console.log('Agent not found:', result.id);
        process.exit(1);
        return;
      }
      console.log('Deleted agent:', result.id);
      if (result.reassignedGroups > 0) {
        console.log('Reassigned', result.reassignedGroups, 'group config(s) to main.');
      }
    } catch (err) {
      console.error('pasture: failed to delete agent.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'server') {
  /**
   * pasture server add <host> <name> [--user <user>] [--alias <alias>]
   * pasture server use <name>
   * pasture server list
   * pasture server remove <name>
   */
  const serverSub = (args[1] || '').toLowerCase();
  (async () => {
    try {
      const regPath = join(INSTALL_DIR, 'lib', 'server-registry.js');
      const mod = await import(pathToFileURL(regPath).href);

      if (serverSub === 'use') {
        const name = args[2];
        if (!name) {
          console.log('Usage: pasture server use <name>');
          console.log('Example: pasture server use prod');
          process.exit(1); return;
        }
        const result = mod.setActiveServer(name);
        if (!result.ok) { console.error('pasture:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else if (serverSub === 'add') {
        const host = args[2];
        const nameArg = (args[3] && !args[3].startsWith('--')) ? args[3] : undefined;
        if (!host || !nameArg) {
          console.log('Usage: pasture server add <host> <name> [--user <user>] [--alias <alias>]');
          console.log('  user defaults to: root');
          console.log('Example: pasture server add 203.0.113.5 prod');
          console.log('         pasture server add 203.0.113.5 staging --user ubuntu');
          console.log('         pasture server add 192.168.1.166 atlas --user root --alias "home assistant"');
          process.exit(1);
          return;
        }
        const userIdx = args.indexOf('--user');
        const keyIdx = args.indexOf('--key');
        const aliasIdx = args.indexOf('--alias');
        const name = nameArg;
        const user = userIdx >= 0 ? args[userIdx + 1] : 'root';
        const key = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
        const alias = aliasIdx >= 0 ? args[aliasIdx + 1] : undefined;
        const result = mod.registerServer(name, host, { user, key, alias });
        if (!result.ok) { console.error('pasture:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else if (serverSub === 'list') {
        const servers = mod.listServers();
        if (!servers.length) {
          console.log('No servers registered yet.');
          console.log('Run: pasture server add <host> [user] [name]');
        } else {
          console.log('Registered servers:');
          for (const s of servers) {
            const parts = [`  ${s.name.padEnd(16)} → ${s.hostname}`];
            if (s.user) parts.push(`(user: ${s.user})`);
            if (s.key) parts.push(`(key: ${s.key})`);
            if (s.alias) parts.push(`[alias: ${s.alias}]`);
            console.log(parts.join(' '));
          }
        }

      } else if (serverSub === 'remove') {
        const name = args[2];
        if (!name) {
          console.log('Usage: pasture server remove <name>');
          process.exit(1); return;
        }
        const result = mod.removeServer(name);
        if (!result.ok) { console.error('pasture:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else {
        console.log('Usage: pasture server add <host> <name> [--user <user>]');
        console.log('       pasture server use <name>');
        console.log('       pasture server list');
        console.log('       pasture server remove <name>');
        process.exit(serverSub ? 1 : 0);
      }
    } catch (err) {
      console.error('pasture: server command failed.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'skills' || sub === 'add' || sub === 'remove') {
  const skillSub = sub === 'skills' ? (args[1] || '').toLowerCase() : '';
  const skillArg = (sub === 'add' || sub === 'remove') ? args[1] : args[2];
  const wantsInstall = sub === 'add' ? !!skillArg : (skillSub === 'install' && !!skillArg);
  const wantsRemove = sub === 'remove' ? !!skillArg : (skillSub === 'remove' && !!skillArg);
  const wantsList = sub === 'skills' && skillSub === 'list';
  const wantsWizard = sub === 'skills' && !skillSub;

  if (wantsInstall) {
    runSkillCommand('install', skillArg);
  } else if (wantsRemove) {
    runSkillCommand('remove', skillArg);
  } else if (wantsList) {
    (async () => {
      try {
        const skillInstallPath = join(INSTALL_DIR, 'lib', 'util', 'skill-install.js');
        const mod = await import(pathToFileURL(skillInstallPath).href);
        mod.printSkillList(INSTALL_DIR);
      } catch (err) {
        console.error('pasture: skills list failed.', err?.message || err);
        process.exit(1);
      }
    })();
  } else if (wantsWizard) {
    (async () => {
      try {
        const skillInstallPath = join(INSTALL_DIR, 'lib', 'util', 'skill-install.js');
        const mod = await import(pathToFileURL(skillInstallPath).href);
        await mod.runSkillsWizard(INSTALL_DIR, {
          onSkillChanged: () => restartBotAfterSkillChange(),
        });
      } catch (err) {
        console.error('pasture: skills wizard failed.', err?.message || err);
        process.exit(1);
      }
    })();
  } else {
    console.log('Usage: pasture skills');
    console.log('       pasture skills list');
    console.log('       pasture skills install <skill-id>');
    console.log('       pasture skills remove <skill-id>');
    console.log('       pasture add <skill-id>');
    console.log('       pasture remove <skill-id>');
    console.log('  Example: pasture skills');
    console.log('  Example: pasture skills install speech');
    console.log('  Example: pasture remove github');
    console.log('  skills: interactive wizard to add, remove, or list skills.');
    console.log('  install: enables a skill and prompts for credentials.');
    console.log('  remove: disables a skill; optionally clears saved credentials.');
    process.exit((sub === 'add' || sub === 'remove' || skillSub === 'install' || skillSub === 'remove') ? 1 : 0);
  }
} else {
  console.log('Usage: pasture start | stop | status | restart');
  console.log('       pasture setup');
  console.log('       pasture logs');
  console.log('       pasture dashboard');
  console.log('       pasture tide checklist list|add|remove|run|triggers|enable|disable');
  console.log('       pasture index [full] [--source memory] [--source filesystem] [--root <path>] [--limit N]');
  console.log('       pasture auth [options]');
  console.log('       pasture create agent <name>');
  console.log('       pasture delete agent <name> [--yes]');
  console.log('       pasture add <skill-id>');
  console.log('       pasture remove <skill-id>');
  console.log('       pasture skills');
  console.log('       pasture skills list');
  console.log('       pasture skills install <skill-id>');
  console.log('       pasture skills remove <skill-id>');
  console.log('       pasture server add <host> <name> [--user <user>] [--alias <alias>]');
  console.log('       pasture server use <name>');
  console.log('       pasture server list');
  console.log('       pasture server remove <name>');
  console.log('       pasture update [--force]');
  console.log('       pasture avatars');
  console.log('       pasture uninstall');
  process.exit(sub ? 1 : 0);
}
