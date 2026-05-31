/**
 * Windows uninstall (no bash required).
 */

import { spawnSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { stopPm2ForUninstall } from './daemon-pm2.js';

function removeFromUserPath(binDir) {
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `$p = [Environment]::GetEnvironmentVariable('Path','User'); $b = '${binDir.replace(/'/g, "''")}'; if ($p) { $parts = $p -split ';' | Where-Object { $_ -and ($_ -ne $b) }; [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User') }`,
      ],
      { encoding: 'utf8', shell: true }
    );
  } catch (_) {}
}

/**
 * @param {{ installDir?: string, removeState?: boolean }} [opts]
 */
export function runUninstall(opts = {}) {
  const installDir = opts.installDir || join(homedir(), '.local', 'share', 'cowcode');
  const binDir = join(homedir(), '.local', 'bin');
  const stateDir = join(homedir(), '.cowcode');
  const removeState = opts.removeState !== false;

  console.log('  cowCode Uninstaller');
  console.log('  -------------------');
  console.log('');

  console.log('  ► Stopping pm2 process...');
  stopPm2ForUninstall();
  console.log('  ✓ Done.');

  for (const name of ['cowcode.cmd', 'cowcode']) {
    const launcher = join(binDir, name);
    if (existsSync(launcher)) {
      console.log(`  ► Removing launcher: ${launcher}`);
      rmSync(launcher, { force: true });
      console.log('  ✓ Done.');
    }
  }

  if (existsSync(installDir)) {
    console.log(`  ► Removing installed code: ${installDir}`);
    rmSync(installDir, { recursive: true, force: true });
    console.log('  ✓ Done.');
  }

  if (removeState && existsSync(stateDir)) {
    console.log(`  ► Removing configuration and state: ${stateDir}`);
    rmSync(stateDir, { recursive: true, force: true });
    console.log('  ✓ Done.');
  }

  removeFromUserPath(binDir);

  console.log('');
  console.log('  ------------------------------------------------');
  console.log('  ✓ cowCode has been successfully uninstalled.');
  console.log('');
}
