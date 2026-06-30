/**
 * Tide test: run one Tide cycle (cron/run-tide.js) with temp state and assert we get a valid response.
 * Uses your real config + .env from ~/.pasture so the LLM runs; typically finishes in 10–30s.
 *
 * Tide follow-up is scheduled when we reply to a private chat; after silenceCooldownMinutes
 * with no user reply we send one follow-up, then stay quiet until the user messages again.
 *
 * Usage:
 *   node scripts/test/test-tide.js
 *   PASTURE_STATE_DIR=/path node scripts/test/test-tide.js  (use that state dir instead of temp)
 */

import { spawn } from 'child_process';
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');
const DEFAULT_STATE_DIR = join(homedir(), '.pasture');
const TIDE_TEST_TIMEOUT_MS = 45_000;

function createTempStateDir() {
  const stateDir = join(tmpdir(), 'pasture-tide-test-' + Date.now());
  const workspaceDir = join(stateDir, 'workspace');
  const cronDir = join(stateDir, 'cron');
  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(cronDir, { recursive: true });
  writeFileSync(join(cronDir, 'jobs.json'), JSON.stringify({ version: 1, jobs: [] }, null, 2), 'utf8');
  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  } else {
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({ llm: { models: [] }, tide: { enabled: true, silenceCooldownMinutes: 30 } }, null, 2),
      'utf8'
    );
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, '.env'), join(stateDir, '.env'));
  }
  if (!existsSync(join(workspaceDir, 'SOUL.md'))) {
    writeFileSync(join(workspaceDir, 'SOUL.md'), 'You are a helpful assistant. Quiet is golden.\n', 'utf8');
  }
  return { stateDir, workspaceDir, storePath: join(cronDir, 'jobs.json') };
}

function runTideOnce(opts = {}) {
  const stateDir = opts.stateDir || createTempStateDir().stateDir;
  let workspaceDir = join(stateDir, 'workspace');
  let storePath = join(stateDir, 'cron', 'jobs.json');
  if (opts.workspaceDir) workspaceDir = opts.workspaceDir;
  if (opts.storePath) storePath = opts.storePath;
  const payload = JSON.stringify({
    jid: '7656021862',
    storePath,
    workspaceDir,
    historyMessages: [
      { role: 'user', content: 'Remind me in 5 minutes to test' },
      { role: 'assistant', content: 'Done. I’ll remind you in 5 minutes.' },
    ],
  });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'cron', 'run-tide.js')], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Tide run timed out after ${TIDE_TEST_TIMEOUT_MS / 1000}s`));
    }, TIDE_TEST_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(lastLine);
        if (parsed.error) {
          reject(new Error(`Tide returned error: ${parsed.error}`));
          return;
        }
        if (typeof parsed.textToSend !== 'string') {
          reject(new Error(`Tide output missing textToSend: ${lastLine.slice(0, 200)}`));
          return;
        }
        resolve({ textToSend: parsed.textToSend, code, signal, stderr, inputPayload: payload });
      } catch (e) {
        reject(
          new Error(
            `Tide invalid output (code ${code}, signal ${signal || 'none'}): ${lastLine.slice(0, 200)}. stderr: ${stderr.slice(-400)}`
          )
        );
      }
    });
    child.stdin.end(payload, 'utf8');
  });
}

async function main() {
  const useExisting = process.env.PASTURE_STATE_DIR && existsSync(process.env.PASTURE_STATE_DIR);
  const stateDir = useExisting ? process.env.PASTURE_STATE_DIR : createTempStateDir().stateDir;

  console.log('Running one Tide cycle (run-tide.js)...');
  console.log('State dir:', stateDir);
  const start = Date.now();
  try {
    const { textToSend, stderr, inputPayload } = await runTideOnce({ stateDir });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const input = JSON.parse(inputPayload);
    console.log('\n--- Input ---');
    console.log(JSON.stringify(input, null, 2));
    console.log('\n--- Output ---');
    console.log('textToSend:', textToSend ?? '(empty)');
    console.log('elapsed:', elapsed, 's');
    if (stderr.trim()) console.log('stderr:', stderr.trim().slice(-300));
    console.log('\nTide test passed.');
  } catch (err) {
    console.error('Tide test failed:', err.message);
    process.exit(1);
  }
}

main();
