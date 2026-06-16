/**
 * SSH inspect executor: run allowlisted read-only commands on a remote host.
 * Spawns local `ssh` with BatchMode=yes; commands execute on the remote and stdout returns here.
 * Host names are resolved against the server registry (config.skills["ssh-inspect"].hosts)
 * before falling back to bare hostname/IP passthrough.
 */

import { spawn } from 'child_process';
import { resolveServer, getActiveServer, listServers } from '../server-registry.js';

const ALLOWED = new Set([
  // Filesystem & disk
  'df', 'du', 'ls', 'pwd', 'find', 'stat', 'file', 'lsblk', 'mount', 'findmnt',
  // File contents
  'cat', 'head', 'tail', 'grep', 'wc', 'readlink', 'realpath',
  // Processes
  'ps', 'top', 'pgrep', 'pmap',
  // Network & ports
  'netstat', 'ss', 'lsof', 'ifconfig', 'ip',
  // System info
  'uname', 'hostname', 'whoami', 'id', 'uptime', 'free', 'dmesg', 'sysctl',
  // Performance
  'vmstat', 'iostat', 'mpstat', 'sar',
  // Services & logs
  'systemctl', 'journalctl', 'service',
  // Environment & paths
  'env', 'printenv', 'which', 'whereis',
  // Users & sessions
  'last', 'lastlog', 'who', 'w',
  // Docker inspection (read-only; each maps to a specific docker subcommand)
  'docker-ps', 'docker-images', 'docker-logs', 'docker-inspect',
  'docker-stats', 'docker-top', 'docker-diff', 'docker-port',
  'docker-network-ls', 'docker-network-inspect',
  'docker-volume-ls', 'docker-volume-inspect',
  'docker-info', 'docker-version', 'docker-system-df', 'docker-image-history',
]);

/**
 * Maps virtual docker command names → the actual argv prefix to execute on the remote.
 * docker-stats always gets --no-stream injected to avoid hanging the SSH session.
 */
const DOCKER_CMD_MAP = {
  'docker-ps':               ['docker', 'ps'],
  'docker-images':           ['docker', 'images'],
  'docker-logs':             ['docker', 'logs'],
  'docker-inspect':          ['docker', 'inspect'],
  'docker-stats':            ['docker', 'stats', '--no-stream'],
  'docker-top':              ['docker', 'top'],
  'docker-diff':             ['docker', 'diff'],
  'docker-port':             ['docker', 'port'],
  'docker-network-ls':       ['docker', 'network', 'ls'],
  'docker-network-inspect':  ['docker', 'network', 'inspect'],
  'docker-volume-ls':        ['docker', 'volume', 'ls'],
  'docker-volume-inspect':   ['docker', 'volume', 'inspect'],
  'docker-info':             ['docker', 'info'],
  'docker-version':          ['docker', 'version'],
  'docker-system-df':        ['docker', 'system', 'df'],
  'docker-image-history':    ['docker', 'image', 'history'],
};
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 50_000;

/** Characters that indicate command injection in any arg. */
const UNSAFE_RE = /[;&|`$()<>\\"\n\r]/;

function limitOutput(text) {
  if (!text) return '';
  const out = String(text).trim();
  if (out.length <= MAX_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_OUTPUT_CHARS) + '\n[... truncated]';
}

function isSafeArg(arg) {
  return !UNSAFE_RE.test(String(arg));
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { host, user?, command, argv? }
 * @returns {Promise<string>}
 */
export async function executeSshInspect(ctx, args) {
  // host is optional — fall back to active server, then to sole registered server
  let hostArg = (args?.host || '').toString().trim();
  if (!hostArg) {
    const active = getActiveServer();
    if (active) {
      hostArg = active;
    } else {
      const all = listServers();
      if (all.length === 1) {
        hostArg = all[0].name;
      } else if (all.length > 1) {
        const names = all.map((s) => s.name).join(', ');
        return JSON.stringify({ error: `Multiple servers registered (${names}) but none set as active and no server mentioned. Specify one with: pasture server use <name>` });
      } else {
        return JSON.stringify({ error: 'No server specified and no servers registered. Add one with: pasture server add <ip> <name>' });
      }
    }
  }

  const cmd = (args?.command || args?.action || '').toString().trim().toLowerCase();
  if (!ALLOWED.has(cmd)) {
    return JSON.stringify({ error: `Command not allowed: "${cmd}". Allowed: ${[...ALLOWED].sort().join(', ')}.` });
  }

  const remoteArgv = Array.isArray(args?.argv) ? args.argv.map((a) => String(a)) : [];

  for (const arg of remoteArgv) {
    if (!isSafeArg(arg)) {
      return JSON.stringify({ error: `Unsafe characters in argv: "${arg}". Only plain paths and flags are allowed.` });
    }
  }

  // Normalise argv: strip surrounding single-quotes from each element, and split any
  // element where a flag and its value were concatenated without a space (e.g. -iname'pat')
  // into two separate tokens so the remote shell receives them correctly.
  const normaliseArgv = (argv) => {
    const out = [];
    for (const rawArg of argv) {
      // Strip wrapping single-quotes (e.g. 'nextpostai*' → nextpostai*)
      let arg = rawArg.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
      // Split -flag'value' or -flag"value" into two tokens (e.g. -iname'foo' → -iname, foo)
      const splitMatch = arg.match(/^(-{1,2}[\w-]+)['"](.+)['"]$/);
      if (splitMatch) {
        out.push(splitMatch[1], splitMatch[2]);
      } else {
        out.push(arg);
      }
    }
    return out;
  };
  const normalisedArgv = normaliseArgv(remoteArgv);

  // Resolve alias from server registry; fall back only for IPs and dotted hostnames
  const registered = resolveServer(hostArg);
  const looksLikeAddress = /^[\d.]+$/.test(hostArg) || hostArg.includes('.');
  if (!registered && !looksLikeAddress) {
    return JSON.stringify({
      error: `Server "${hostArg}" is not in the registry. Register it first:\n  pasture server add <ip> ${hostArg}`,
    });
  }
  const hostname = registered?.hostname || hostArg;
  // Registry user takes priority — agent-passed user only used for bare IP/hostname passthroughs
  const user = registered?.user || args?.user || process.env.SSH_INSPECT_USER || '';
  const identityFile = registered?.key || process.env.SSH_INSPECT_IDENTITY || '';
  const timeoutMs = parseInt(process.env.SSH_INSPECT_TIMEOUT || '', 10) * 1000 || DEFAULT_TIMEOUT_MS;
  const connectTimeoutSecs = Math.max(5, Math.floor(timeoutMs / 1000 / 3));

  // Build a human-readable server label for the LLM to use in replies (e.g. "atlas (home assistant)")
  const serverLabel = registered?.alias
    ? `${hostArg} (${registered.alias})`
    : hostArg;

  const destination = user ? `${user}@${hostname}` : hostname;

  const cmdParts = DOCKER_CMD_MAP[cmd] ? [...DOCKER_CMD_MAP[cmd]] : [cmd];
  const remoteCmd = [...cmdParts, ...normalisedArgv].join(' ');

  const sshArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `-o`, `ConnectTimeout=${connectTimeoutSecs}`,
  ];

  if (identityFile) {
    sshArgs.push('-i', identityFile);
  }

  sshArgs.push(destination, remoteCmd);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    const child = spawn('ssh', sshArgs);

    const timeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(JSON.stringify({ error: `Command timed out after ${timeoutMs / 1000}s.` }));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve(JSON.stringify({ error: err.message }));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      const out = limitOutput(stdout);
      const err = limitOutput(stderr);
      const prefix = `[${serverLabel}]\n`;
      if (code === 0) {
        resolve(prefix + (out || err || 'OK'));
        return;
      }
      resolve(JSON.stringify({
        server: serverLabel,
        error: err || out || `ssh exited with code ${code}`,
        stdout: out || undefined,
        stderr: err || undefined,
      }));
    });
  });
}
