/**
 * E2E test for the exec skill through the main chatting interface.
 * Flow: user message -> LLM -> exec skill -> fake npx create-next-app -> read-back -> reply.
 *
 * The test uses a fake npx placed first on exec's configured PATH so no network
 * or package download is required. The fake binary is intentionally strict: it
 * only succeeds when create-next-app@latest is invoked.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { spawn } from 'child_process';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runSkillTests } from '../../../support/skill-test-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const DEFAULT_STATE_DIR = process.env.PASTURE_SOURCE_STATE_DIR || join(homedir(), '.pasture');
const APP_NAME = 'e2e-next-exec';
const USER_MESSAGE = 'Use npx create-next-app@latest to create a Next.js app named e2e-next-exec with TypeScript, Tailwind CSS, App Router, ESLint, npm, and recommended defaults in the workspace.';
const PER_TEST_TIMEOUT_MS = 180_000;
const E2E_REPLY_MARKER_START = 'E2E_REPLY_START';
const E2E_REPLY_MARKER_END = 'E2E_REPLY_END';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonFile(path, fallback = {}) {
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function createTempStateDir() {
  const stateDir = join(tmpdir(), `pasture-exec-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  for (const name of ['config.json', '.env', 'secrets.json']) {
    const src = join(DEFAULT_STATE_DIR, name);
    if (existsSync(src)) copyFileSync(src, join(stateDir, name));
  }
  return stateDir;
}

function installFakeNpx(binDir) {
  mkdirSync(binDir, { recursive: true });
  const npxPath = join(binDir, 'npx');
  writeFileSync(npxPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), 'exec-npx-args.json'), JSON.stringify({ cwd: process.cwd(), args }, null, 2));

const generatorIndex = args.findIndex((arg) => arg === 'create-next-app@latest');
if (generatorIndex < 0) fail('fake npx expected create-next-app@latest');

let target = '';
for (let i = generatorIndex + 1; i < args.length; i += 1) {
  const arg = args[i];
  if (!arg || arg.startsWith('-')) continue;
  if (arg === '@/*') continue;
  target = arg;
  break;
}
if (!target) fail('fake npx expected a project target after create-next-app@latest');

const targetPath = path.resolve(process.cwd(), target);
fs.mkdirSync(path.join(targetPath, 'app'), { recursive: true });
fs.writeFileSync(path.join(targetPath, 'package.json'), JSON.stringify({
  scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
  dependencies: { next: 'latest', react: 'latest', 'react-dom': 'latest' },
  devDependencies: { typescript: 'latest', tailwindcss: 'latest', eslint: 'latest' }
}, null, 2));
fs.writeFileSync(path.join(targetPath, 'app', 'page.tsx'), 'export default function Page() { return <main>Exec Next.js E2E</main>; }\\n');
fs.writeFileSync(path.join(targetPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve' } }, null, 2));
fs.writeFileSync(path.join(targetPath, 'tailwind.config.ts'), 'export default {};\\n');
console.log('Success! Created ' + target + ' with fake create-next-app@latest');
`, 'utf8');
  chmodSync(npxPath, 0o755);
}

function configureStateForExec(stateDir) {
  const workspaceDir = join(stateDir, 'workspace');
  const binDir = join(stateDir, 'bin');
  installFakeNpx(binDir);

  const configPath = join(stateDir, 'config.json');
  const config = readJsonFile(configPath, {});
  config.skills = {
    ...(config.skills && typeof config.skills === 'object' ? config.skills : {}),
    enabled: ['exec', 'go-read', 'read'],
    exec: {
      mode: 'allowlist',
      allowlist: ['npx', 'node'],
      pathPrepend: [binDir],
      timeoutMs: 60_000,
    },
  };
  config.agentMessaging = { allow: [], maxDepth: 2, maxCallsPerTurn: 5 };
  writeJsonFile(configPath, config);
  rmSync(join(stateDir, 'agents'), { recursive: true, force: true });

  return {
    workspaceDir,
    binDir,
    appDir: join(workspaceDir, APP_NAME),
    invocationPath: join(workspaceDir, 'exec-npx-args.json'),
  };
}

function runE2E(userMessage, opts = {}) {
  const env = { ...process.env };
  env.PASTURE_E2E_LIVE_LOG = '1';
  if (opts.stateDir) env.PASTURE_STATE_DIR = opts.stateDir;
  const timeoutMs = opts.timeoutMs || PER_TEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['index.js', '--test', userMessage], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const err = new Error(`E2E run timed out after ${timeoutMs / 1000}s`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timeout);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      const startIdx = stdout.indexOf(E2E_REPLY_MARKER_START);
      const endIdx = stdout.indexOf(E2E_REPLY_MARKER_END);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        const err = new Error(`No E2E reply in output (code ${code}). stderr: ${stderr.slice(-1000)}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      const reply = stdout
        .slice(startIdx + E2E_REPLY_MARKER_START.length, endIdx)
        .replace(/^\n+|\n+$/g, '')
        .trim();
      const skillsMatch = stdout.match(/E2E_SKILLS_CALLED:\s*(.+)/);
      const skillsCalled = skillsMatch
        ? skillsMatch[1].trim().split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      if (code !== 0) {
        const err = new Error(`Process exited ${code}. Reply: ${reply.slice(0, 200)}`);
        err.reply = reply;
        err.skillsCalled = skillsCalled;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ reply, skillsCalled, stderr, stdout });
    });
  });
}

function readPrivateChatLogText(stateDir) {
  const privateDir = join(stateDir, 'workspace', 'chat-log', 'private');
  if (!existsSync(privateDir)) return '';
  const chunks = [];
  for (const name of readdirSync(privateDir)) {
    if (!name.endsWith('.jsonl')) continue;
    chunks.push(`--- ${name} ---`);
    chunks.push(readFileSync(join(privateDir, name), 'utf8'));
  }
  return chunks.join('\n');
}

function collectDiagnostics(stateDir, paths, result) {
  const parts = [];
  if (result?.reply) parts.push(`Reply:\n${result.reply}`);
  if (Array.isArray(result?.skillsCalled)) parts.push(`Skills called: ${result.skillsCalled.join(', ') || 'none'}`);
  if (result?.stdout) parts.push(`stdout tail:\n${String(result.stdout).slice(-2000)}`);
  if (result?.stderr) parts.push(`stderr tail:\n${String(result.stderr).slice(-2000)}`);
  if (paths?.invocationPath && existsSync(paths.invocationPath)) {
    parts.push(`Fake npx invocation:\n${readFileSync(paths.invocationPath, 'utf8')}`);
  } else {
    parts.push('Fake npx invocation: missing');
  }
  const chatLog = readPrivateChatLogText(stateDir);
  const matchingLines = chatLog
    .split('\n')
    .filter((line) => line.includes('Next.js') || line.includes('create-next-app@latest') || line.includes(APP_NAME))
    .slice(-8);
  parts.push(`Chat-log lines mentioning Next.js/create-next-app/${APP_NAME}:\n${matchingLines.join('\n') || '(none)'}`);
  return parts.join('\n\n');
}

function assertReplyDidNotRefuse(reply) {
  const text = String(reply || '').toLowerCase();
  const forbidden = [
    "don't have next.js",
    'do not have next.js',
    "don't have the next.js",
    'do not have the next.js',
    "don't have npx",
    'do not have npx',
    'unable to create',
    'cannot create',
    "can't create",
    'not available',
  ];
  const hit = forbidden.find((fragment) => text.includes(fragment));
  assert(!hit, `reply looks like a refusal (${hit}): ${reply}`);
}

function assertNextAppCreated(paths) {
  assert(existsSync(paths.appDir), `expected app directory at ${paths.appDir}`);
  assert(existsSync(join(paths.appDir, 'package.json')), 'expected Next.js package.json');
  assert(existsSync(join(paths.appDir, 'app', 'page.tsx')), 'expected App Router page.tsx');
  assert(existsSync(join(paths.appDir, 'tailwind.config.ts')), 'expected Tailwind config');
  const pkg = readJsonFile(join(paths.appDir, 'package.json'), {});
  assert(pkg.dependencies?.next, 'package.json should include next dependency');
  assert(pkg.devDependencies?.typescript, 'package.json should include typescript dev dependency');
  assert(pkg.devDependencies?.tailwindcss, 'package.json should include tailwindcss dev dependency');
}

function assertNpxInvocation(paths) {
  assert(existsSync(paths.invocationPath), 'fake npx was not invoked');
  const invocation = readJsonFile(paths.invocationPath, {});
  assert(Array.isArray(invocation.args), 'fake npx invocation must include argv');
  assert(invocation.args.includes('create-next-app@latest'), `expected create-next-app@latest in argv: ${JSON.stringify(invocation.args)}`);
  assert(invocation.args.some((arg) => String(arg).includes(APP_NAME)), `expected app name in argv: ${JSON.stringify(invocation.args)}`);
}

async function main() {
  console.log('E2E tests: exec skill (chat asks for npx create-next-app@latest).');
  console.log('Timeout per test:', PER_TEST_TIMEOUT_MS / 1000, 's.\n');

  const stateDir = createTempStateDir();
  const paths = configureStateForExec(stateDir);

  const tests = [
    {
      name: 'exec: create Next.js app via npx create-next-app@latest',
      input: USER_MESSAGE,
      expectMode: 'actual',
      skill: 'exec',
      stateDir,
      actualChecks: { fileExists: `workspace/${APP_NAME}/package.json` },
      run: async () => {
        let result;
        try {
          result = await runE2E(USER_MESSAGE, { stateDir, timeoutMs: PER_TEST_TIMEOUT_MS });
          assert(result.skillsCalled.includes('exec'), `expected exec skill, got [${result.skillsCalled.join(', ') || 'none'}]`);
          assert(!result.skillsCalled.includes('go-write'), `expected exec path, but go-write was called: [${result.skillsCalled.join(', ')}]`);
          assertReplyDidNotRefuse(result.reply);
          assertNextAppCreated(paths);
          assertNpxInvocation(paths);
          const chatLog = readPrivateChatLogText(stateDir);
          assert(chatLog.includes('Next.js') && chatLog.includes(APP_NAME), 'chat log should contain the Next.js creation request');
          return { ...result, stateDir };
        } catch (err) {
          const diagnostics = collectDiagnostics(stateDir, paths, result || err);
          const wrapped = new Error(`${err?.message || String(err)}\n\n${diagnostics}`);
          wrapped.reply = result?.reply || err?.reply;
          wrapped.skillsCalled = result?.skillsCalled || err?.skillsCalled;
          throw wrapped;
        }
      },
    },
  ];

  const { failed } = await runSkillTests('exec', tests);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
