/**
 * Server Inspection Test — end-to-end scenarios against real registered servers.
 *
 * Asks the agent natural-language questions about the servers; the agent must
 * use ssh-inspect to answer. Each test validates:
 *   - The right skill was called (ssh-inspect)
 *   - The reply contains real output (not an error or empty shell)
 *   - The LLM judge confirms the user got what they wanted
 *
 * Scenarios:
 *   1. List code/project repos visible on each registered server
 *   2. List log files on each registered server
 *   3. Ask about both servers in one message (multi-server, multi-part)
 *
 * Prerequisites:
 *   - ssh-inspect in skills.enabled
 *   - At least one server registered (pasture server add ...)
 *   - SSH key access to each server
 *
 * Run:
 *   node scripts/test/test-server-inspect-e2e.js
 */

import { spawn } from 'child_process';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';
import { runSkillTests } from './skill-test-runner.js';
import { judgeUserGotWhatTheyWanted } from './e2e-judge.js';
import { skipSuiteIf } from './e2e-skip.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');
const PER_TEST_TIMEOUT_MS = 120_000;

// ─── preflight ───────────────────────────────────────────────────────────────

function loadRegisteredServers() {
  const configPath = join(DEFAULT_STATE_DIR, 'config.json');
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const hosts = config.skills?.['ssh-inspect']?.hosts || {};
    return Object.entries(hosts).map(([name, entry]) => ({
      name,
      hostname: entry.hostname,
      alias: entry.alias || null,
    }));
  } catch {
    return [];
  }
}

function ensureSshInspectEnabled() {
  const configPath = join(DEFAULT_STATE_DIR, 'config.json');
  if (!existsSync(configPath)) {
    throw new Error(`No config at ${configPath}. Add ssh-inspect to skills.enabled.`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const enabled = Array.isArray(config.skills?.enabled) ? config.skills.enabled : [];
  if (!enabled.includes('ssh-inspect')) {
    throw new Error(
      `ssh-inspect is not in skills.enabled at ${configPath}.\nAdd "ssh-inspect" to config.skills.enabled and re-run.`
    );
  }
  const servers = loadRegisteredServers();
  if (servers.length === 0) {
    throw new Error(
      'No servers registered. Add one with:\n  pasture server add <ip> <name>'
    );
  }
  return servers;
}

// ─── runner ──────────────────────────────────────────────────────────────────

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-server-inspect-e2e-' + Date.now());
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  return stateDir;
}

function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['index.js', '--test', userMessage], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timed out after ${PER_TEST_TIMEOUT_MS / 1000}s`));
    }, PER_TEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timeout); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const startIdx = stdout.indexOf('E2E_REPLY_START');
      const endIdx = stdout.indexOf('E2E_REPLY_END');
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        reject(new Error(`No E2E reply markers (exit ${code}). stderr: ${stderr.slice(-500)}`));
        return;
      }
      const reply = stdout
        .slice(startIdx + 'E2E_REPLY_START'.length, endIdx)
        .replace(/^\n+|\n+$/g, '')
        .trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch
        ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (code !== 0) {
        reject(new Error(`Process exited ${code}. Reply: ${reply.slice(0, 200)}`));
        return;
      }
      resolve({ reply, skillsCalled, stderr });
    });
  });
}

function assertSshInspectCalled(skillsCalled) {
  if (!skillsCalled.includes('ssh-inspect')) {
    throw new Error(
      `Expected ssh-inspect to be called but got: [${skillsCalled.join(', ')}]`
    );
  }
}

// ─── test factory ────────────────────────────────────────────────────────────

/**
 * Build one test case per server per topic.
 * Topic drives both the natural-language question and the judge criteria.
 * No hardcoded paths or project names — the agent decides what to search for.
 */
function makeTests(servers, stateDir) {
  const tests = [];

  for (const server of servers) {
    const label = server.alias ? `${server.name} (${server.alias})` : server.name;

    // ── 1. Code / project repos ────────────────────────────────────────────
    tests.push({
      name: `[${label}] list project / code repos visible on the server`,
      expectMode: 'actual',
      skill: 'ssh-inspect',
      run: async () => {
        const message = `What code repositories or project folders do you see on ${server.name}?`;
        const { reply, skillsCalled } = await runE2E(message, { stateDir });
        assertSshInspectCalled(skillsCalled);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
          prompt:
            `The user asked what code or project folders are on server "${label}".\n` +
            `The bot replied:\n\n---\n${reply}\n---\n\n` +
            `Did the reply contain actual directory or folder names (or clearly say none were found after checking)? ` +
            `A reply that refuses to look, gives only error text without any inspection result, or is empty is NO. ` +
            `A connection error alone is NO — real output or an explicit empty result after inspection is required.\n` +
            `Answer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    });

    // ── 2. Log files ───────────────────────────────────────────────────────
    tests.push({
      name: `[${label}] list log files visible on the server`,
      expectMode: 'actual',
      skill: 'ssh-inspect',
      run: async () => {
        const message = `What log files do you see on ${server.name}?`;
        const { reply, skillsCalled } = await runE2E(message, { stateDir });
        assertSshInspectCalled(skillsCalled);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
          prompt:
            `The user asked what log files are on server "${label}".\n` +
            `The bot replied:\n\n---\n${reply}\n---\n\n` +
            `Did the reply list actual log file paths or directories (e.g. /var/log contents), ` +
            `or clearly say none were found after checking? ` +
            `A reply that refuses to look, gives only error text without any inspection result, or is empty is NO. ` +
            `A connection error alone is NO — real output or an explicit empty result after inspection is required.\n` +
            `Answer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    });
  }

  // ── 3. Multi-server in one message (only when 2+ servers registered) ─────
  if (servers.length >= 2) {
    const s1 = servers[0];
    const s2 = servers[1];
    const label1 = s1.alias ? `${s1.name} (${s1.alias})` : s1.name;
    const label2 = s2.alias ? `${s2.name} (${s2.alias})` : s2.name;
    tests.push({
      name: `[multi-server] disk usage on ${s1.name} and uptime on ${s2.name} in one message`,
      expectMode: 'actual',
      skill: 'ssh-inspect',
      run: async () => {
        const message =
          `Check disk usage on ${s1.name} and uptime on ${s2.name} — tell me both.`;
        const { reply, skillsCalled } = await runE2E(message, { stateDir });
        assertSshInspectCalled(skillsCalled);
        const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
          prompt:
            `The user asked for disk usage from "${label1}" AND uptime from "${label2}" in a single message.\n` +
            `The bot replied:\n\n---\n${reply}\n---\n\n` +
            `Did the reply address BOTH servers with real command output or explicit empty results? ` +
            `If either server's result is completely missing (not attempted at all), answer NO. ` +
            `Connection errors alone are NO.\n` +
            `Answer YES or NO then one short sentence.`,
        });
        if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
        return { reply, skillsCalled };
      },
    });
  }

  tests.push({
    name: '[behavior] unreachable host — clear connection error is acceptable',
    expectMode: 'behavior',
    run: async () => {
      const message = 'What log files do you see on cowcode-e2e-unreachable-host?';
      const { reply, skillsCalled } = await runE2E(message, { stateDir });
      assertSshInspectCalled(skillsCalled);
      const { pass, reason } = await judgeUserGotWhatTheyWanted(message, reply, stateDir, {
        prompt:
          `The user asked about log files on a server that is not registered or unreachable.\n` +
          `The bot replied:\n\n---\n${reply}\n---\n\n` +
          `Did the bot attempt ssh-inspect and give a clear connection or host error (not a fake file list)? ` +
          `Answer YES if the skill ran and the error is honest. Answer NO if it invented data or refused without trying.\n` +
          `Answer YES or NO then one short sentence.`,
      });
      if (!pass) throw Object.assign(new Error(`Judge: ${reason}`), { reply, skillsCalled });
      return { reply, skillsCalled };
    },
  });

  return tests;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Server Inspection Test — ssh-inspect E2E\n');

  let servers;
  try {
    servers = ensureSshInspectEnabled();
  } catch (err) {
    skipSuiteIf('server-inspect-e2e', () => err?.message || 'ssh-inspect not configured');
    return;
  }
  console.log(
    'Registered servers:',
    servers.map((s) => s.alias ? `${s.name} (${s.alias})` : s.name).join(', '),
    '\n'
  );

  const stateDir = createTempStateDir();
  const tests = makeTests(servers, stateDir);
  const { failed } = await runSkillTests('ssh-inspect', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
