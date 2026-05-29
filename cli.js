#!/usr/bin/env node
/**
 * CLI entry: auth, start/stop/status/restart, update, and skill add/install.
 * Usage: cowcode auth | cowcode start|stop|status|restart | cowcode logs | cowcode add <skill-id> | cowcode update [--force]
 */

import { spawn, spawnSync, execSync } from 'child_process';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import readline from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = process.env.COWCODE_INSTALL_DIR
  ? resolve(process.env.COWCODE_INSTALL_DIR)
  : __dirname;

const args = process.argv.slice(2);
const sub = args[0];
const isForceUpdate = args.slice(1).some((a) => a === '--force' || a === '-f');

/** After a successful update: restart the daemon and run dashboard, with clear logging. */
function runPostUpdateRestartAndDashboard() {
  console.log('');
  console.log('  Restarting bot and starting dashboard...');
  const daemonScript = join(INSTALL_DIR, 'scripts', 'daemon.sh');
  if (existsSync(daemonScript)) {
    const restartResult = spawnSync('bash', [daemonScript, 'restart'], {
      stdio: 'inherit',
      env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
      cwd: INSTALL_DIR,
    });
    if (restartResult.status === 0) {
      console.log('  ✓ Restarted.');
    } else {
      console.error('  ✗ Restart had issues. You can run: cowcode restart');
    }
  } else {
    console.log('  (daemon script not found; run cowcode start if needed)');
  }
  const serverPath = join(INSTALL_DIR, 'dashboard', 'server.js');
  if (existsSync(serverPath)) {
    const dashResult = spawnSync(process.execPath, [join(INSTALL_DIR, 'cli.js'), 'dashboard'], {
      stdio: 'inherit',
      env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
      cwd: INSTALL_DIR,
    });
    if (dashResult.status === 0) {
      console.log('  ✓ Dashboard started.');
    } else {
      console.error('  ✗ Dashboard failed to start. You can run: cowcode dashboard');
    }
  } else {
    console.log('  (dashboard not found; run cowcode dashboard if needed)');
  }
  console.log('');
}

function runDaemonAction(action) {
  const script = join(INSTALL_DIR, 'scripts', 'daemon.sh');
  if (!existsSync(script)) {
    console.error('cowCode: installation incomplete or corrupted.');
    console.error('  Re-run the installer:');
    console.error('  curl -fsSL https://raw.githubusercontent.com/bishwashere/cowCode/master/install.sh | bash');
    process.exit(1);
  }
  const child = spawn('bash', [script, action], {
    stdio: 'inherit',
    env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

if (['start', 'stop', 'status', 'restart'].includes(sub)) {
  runDaemonAction(sub);
} else if (sub === 'dashboard') {
  (async () => {
    const serverPath = join(INSTALL_DIR, 'dashboard', 'server.js');
    if (!existsSync(serverPath)) {
      console.error('cowCode: dashboard not found. Re-run the installer or run from repo.');
      process.exit(1);
    }
    const port = process.env.COWCODE_DASHBOARD_PORT || '3847';
    const host = process.env.COWCODE_DASHBOARD_HOST || '127.0.0.1';
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
      env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
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
} else if (sub === 'auth' || (args.length === 1 && args[0] === '--auth-only')) {
  const authArgs = args[0] === '--auth-only' ? args : ['--auth-only', ...args.slice(1)];
  const child = spawn(process.execPath, [join(INSTALL_DIR, 'index.js'), ...authArgs], {
    stdio: 'inherit',
    env: process.env,
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'update') {
  const branch = process.env.COWCODE_BRANCH || 'master';
  const env = { ...process.env, COWCODE_ROOT: INSTALL_DIR };

  if (isForceUpdate) {
    // Run latest update.sh from GitHub so --force works even when installed script is old
    const url = `https://raw.githubusercontent.com/bishwashere/cowCode/${branch}/update.sh?t=${Date.now()}`;
    const tmpScript = join(tmpdir(), `cowcode-update-${Date.now()}.sh`);
    const curl = spawnSync('curl', ['-fsSL', '-H', 'Cache-Control: no-cache', url, '-o', tmpScript], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    if (curl.status !== 0) {
      console.error('cowCode: failed to fetch update script from GitHub.');
      process.exit(1);
    }
    const child = spawn('bash', [tmpScript, '--force'], {
      stdio: 'inherit',
      env: { ...env, COWCODE_ROOT: INSTALL_DIR },
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
      console.error('cowCode: update.sh not found. Re-run the installer.');
      console.error('  curl -fsSL https://raw.githubusercontent.com/bishwashere/cowCode/master/install.sh | bash');
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
} else if (sub === 'uninstall') {
  const script = join(INSTALL_DIR, 'uninstall.sh');
  if (!existsSync(script)) {
    console.error('cowCode: uninstall.sh not found. Re-run the installer.');
    console.error('  curl -fsSL https://raw.githubusercontent.com/bishwashere/cowCode/master/install.sh | bash');
    process.exit(1);
  }
  const child = spawn('bash', [script], {
    stdio: 'inherit',
    env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'logs') {
  const stateDir = process.env.COWCODE_STATE_DIR || join(homedir(), '.cowcode');
  const logPath = join(stateDir, 'daemon.log');
  if (process.platform === 'win32') {
    const child = spawn('pm2', ['logs', 'cowcode'], {
      stdio: 'inherit',
      env: process.env,
      cwd: INSTALL_DIR,
    });
    child.on('close', (code) => process.exit(code ?? 0));
  } else {
    if (!existsSync(logPath)) {
      console.error('cowCode: no log file yet. Start the bot with: cowcode start');
      process.exit(1);
    }
    const child = spawn('tail', ['-f', logPath], { stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 0));
  }
} else if (sub === 'tide') {
  const tideScript = join(INSTALL_DIR, 'scripts', 'tide-cli.js');
  if (!existsSync(tideScript)) {
    console.error('cowcode: scripts/tide-cli.js not found.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [tideScript, ...args.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'index') {
  const indexScript = join(INSTALL_DIR, 'scripts', 'index-cli.js');
  if (!existsSync(indexScript)) {
    console.error('cowcode: scripts/index-cli.js not found.');
    process.exit(1);
  }
  const child = spawn(process.execPath, [indexScript, ...args.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, COWCODE_STATE_DIR: process.env.COWCODE_STATE_DIR },
    cwd: INSTALL_DIR,
  });
  child.on('close', (code) => process.exit(code ?? 0));
} else if (sub === 'create') {
  const kind = (args[1] || '').toLowerCase();
  const name = args.slice(2).join(' ').trim();
  if (kind !== 'agent' || !name) {
    console.log('Usage: cowcode create agent <name>');
    console.log('Example: cowcode create agent alex');
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
      console.error('cowCode: failed to create agent.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'delete') {
  const kind = (args[1] || '').toLowerCase();
  const name = args.slice(2).filter((a) => a !== '--yes' && a !== '-y').join(' ').trim();
  const forceYes = args.includes('--yes') || args.includes('-y');
  if (kind !== 'agent' || !name) {
    console.log('Usage: cowcode delete agent <name> [--yes]');
    console.log('Example: cowcode delete agent alex');
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
      console.error('cowCode: failed to delete agent.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'server') {
  /**
   * cowcode server add <host> <name> [--user <user>] [--alias <alias>]
   * cowcode server use <name>
   * cowcode server list
   * cowcode server remove <name>
   */
  const serverSub = (args[1] || '').toLowerCase();
  (async () => {
    try {
      const regPath = join(INSTALL_DIR, 'lib', 'server-registry.js');
      const mod = await import(pathToFileURL(regPath).href);

      if (serverSub === 'use') {
        const name = args[2];
        if (!name) {
          console.log('Usage: cowcode server use <name>');
          console.log('Example: cowcode server use prod');
          process.exit(1); return;
        }
        const result = mod.setActiveServer(name);
        if (!result.ok) { console.error('cowCode:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else if (serverSub === 'add') {
        const host = args[2];
        const nameArg = (args[3] && !args[3].startsWith('--')) ? args[3] : undefined;
        if (!host || !nameArg) {
          console.log('Usage: cowcode server add <host> <name> [--user <user>] [--alias <alias>]');
          console.log('  user defaults to: root');
          console.log('Example: cowcode server add 203.0.113.5 prod');
          console.log('         cowcode server add 203.0.113.5 staging --user ubuntu');
          console.log('         cowcode server add 192.168.1.166 atlas --user root --alias "home assistant"');
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
        if (!result.ok) { console.error('cowCode:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else if (serverSub === 'list') {
        const servers = mod.listServers();
        if (!servers.length) {
          console.log('No servers registered yet.');
          console.log('Run: cowcode server add <host> [user] [name]');
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
          console.log('Usage: cowcode server remove <name>');
          process.exit(1); return;
        }
        const result = mod.removeServer(name);
        if (!result.ok) { console.error('cowCode:', result.message); process.exit(1); return; }
        console.log('✓', result.message);

      } else {
        console.log('Usage: cowcode server add <host> <name> [--user <user>]');
        console.log('       cowcode server use <name>');
        console.log('       cowcode server list');
        console.log('       cowcode server remove <name>');
        process.exit(serverSub ? 1 : 0);
      }
    } catch (err) {
      console.error('cowCode: server command failed.', err?.message || err);
      process.exit(1);
    }
  })();
} else if (sub === 'skills' || sub === 'add') {
  const skillSub = args[1];
  const skillArg = sub === 'add' ? args[1] : args[2];
  const wantsInstall = sub === 'add' ? !!skillArg : (skillSub === 'install' && !!skillArg);
  if (wantsInstall) {
    (async () => {
      try {
        const skillInstallPath = join(INSTALL_DIR, 'lib', 'skill-install.js');
        const mod = await import(pathToFileURL(skillInstallPath).href);
        const result = await mod.runSkillInstall(skillArg, INSTALL_DIR);
        if (!result.ok) {
          console.error('cowCode:', result.message);
          process.exit(1);
        }
        const daemonScript = join(INSTALL_DIR, 'scripts', 'daemon.sh');
        if (existsSync(daemonScript)) {
          console.log('');
          console.log('Restarting bot to apply skill changes...');
          const restartResult = spawnSync('bash', [daemonScript, 'restart'], {
            stdio: 'inherit',
            env: { ...process.env, COWCODE_INSTALL_DIR: INSTALL_DIR },
            cwd: INSTALL_DIR,
          });
          if (restartResult.status === 0) {
            console.log('  ✓ Bot restarted.');
          } else {
            console.error('  ✗ Auto-restart failed. Run: cowcode restart');
          }
        } else {
          console.log('Restart skipped (daemon script not found). Run: cowcode restart');
        }
      } catch (err) {
        console.error('cowCode: skills install failed.', err?.message || err);
        process.exit(1);
      }
    })();
  } else {
    console.log('Usage: cowcode add <skill-id>');
    console.log('   or: cowcode skills install <skill-id>');
    console.log('  Example: cowcode add speech');
    console.log('  Example: cowcode add github');
    console.log('  Example: cowcode add google');
    console.log('  Enables a skill and prompts for whatever credentials it needs.');
    process.exit((sub === 'add' || skillSub === 'install') ? 1 : 0);
  }
} else {
  console.log('Usage: cowcode start | stop | status | restart');
  console.log('       cowcode logs');
  console.log('       cowcode dashboard');
  console.log('       cowcode tide checklist list|add|remove|run|triggers|enable|disable');
  console.log('       cowcode index [full] [--source memory] [--source filesystem] [--root <path>] [--limit N]');
  console.log('       cowcode auth [options]');
  console.log('       cowcode create agent <name>');
  console.log('       cowcode delete agent <name> [--yes]');
  console.log('       cowcode add <skill-id>');
  console.log('       cowcode skills install <skill-id>');
  console.log('       cowcode server add <host> <name> [--user <user>] [--alias <alias>]');
  console.log('       cowcode server use <name>');
  console.log('       cowcode server list');
  console.log('       cowcode server remove <name>');
  console.log('       cowcode update [--force]');
  console.log('       cowcode uninstall');
  process.exit(sub ? 1 : 0);
}
