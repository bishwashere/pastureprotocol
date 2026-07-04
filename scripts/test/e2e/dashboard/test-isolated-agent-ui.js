#!/usr/bin/env node
/**
 * Isolated API-agent UI regression test.
 *
 * Starts a dashboard server with a temporary Pasture state, creates an
 * API-only isolated agent through the browser UI, and verifies:
 * - UI creation writes the expected agent files/config.
 * - The agent is usable from the normal dashboard chat selector.
 * - The Team/agent map shows it with an API-isolated badge.
 * - The backend team/delegation pool still excludes it.
 * - Agent messaging is disabled for delegation.
 * - A UI chat turn for the isolated agent uses api:<agent>:<conversation>
 *   sessions/logs under the isolated agent workspace.
 *
 * The chat test sends "new session" so it exercises the isolated chat route
 * without making a live LLM call.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { createServer } from 'net';
import { spawn } from 'child_process';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../../../..');
const SERVER_PATH = join(ROOT, 'dashboard', 'server.js');

const rows = [];
function pass(name, detail = '') {
  rows.push({ name, ok: true, detail });
  console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`);
}

function fail(name, err) {
  const detail = err?.message || String(err);
  rows.push({ name, ok: false, detail });
  console.error(`[FAIL] ${name} — ${detail}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForDashboard(baseUrl, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl + '/api/status');
      if (res.ok) return;
      lastErr = new Error('status ' + res.status);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastErr || new Error('dashboard did not start');
}

async function jsonFetch(baseUrl, path, opts = {}) {
  const res = await fetch(baseUrl + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${path} failed (${res.status}): ${data.error || JSON.stringify(data)}`);
  }
  return data;
}

function normalizeAgentId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function listJsonlRows(dir) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = join(dir, name);
    const lines = readFileSync(full, 'utf8').split('\n').filter((line) => line.trim());
    for (const line of lines) rows.push(JSON.parse(line));
  }
  return rows;
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-isolated-ui-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;
  let browser = null;

  const suffix = Date.now().toString(36);
  const normalId = `normal-${suffix}`;
  const isolatedTitle = `iso-ui-${suffix}`;
  const isolatedId = normalizeAgentId(isolatedTitle);

  try {
    mkdirSync(join(stateDir, 'workspace'), { recursive: true });
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({
        agents: { defaults: { userTimezone: 'UTC', sessionResetHour: 3 } },
        llm: { models: [] },
        skills: { enabled: ['search'] },
      }, null, 2),
      'utf8',
    );

    child = spawn(process.execPath, [SERVER_PATH], {
      cwd: ROOT,
      env: {
        ...process.env,
        PASTURE_STATE_DIR: stateDir,
        PASTURE_INSTALL_DIR: ROOT,
        PASTURE_DASHBOARD_HOST: '127.0.0.1',
        PASTURE_DASHBOARD_PORT: String(port),
        LLM_1_API_KEY: '',
        OPENAI_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverOutput = '';
    child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
    await waitForDashboard(baseUrl);
    pass('dashboard test server starts', baseUrl);

    await jsonFetch(baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ id: normalId, title: 'Normal Peer' }),
    });
    pass('normal peer agent exists for delegation contrast', normalId);

    const mainWorkspace = join(stateDir, 'agents', 'main', 'workspace');
    const mainPrivateDir = join(mainWorkspace, 'chat-log', 'private');
    mkdirSync(mainPrivateDir, { recursive: true });
    writeFileSync(
      join(mainPrivateDir, 'owner.jsonl'),
      JSON.stringify({
        ts: Date.now(),
        jid: 'owner',
        sessionId: 'seed-main',
        user: 'remember secret code 9911',
        assistant: 'stored',
      }) + '\n',
      'utf8',
    );

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    await page.goto(baseUrl + '/home', { waitUntil: 'networkidle' });
    await page.click('#chat-agent-create-btn');
    await page.fill('#agent-create-modal-title-input', isolatedTitle);
    await page.check('#agent-create-modal-api-only');
    await page.click('#agent-create-modal-submit');
    await page.waitForFunction((id) => {
      return [...document.querySelectorAll('#chat-agent-select option')]
        .some((opt) => opt.value === id && opt.textContent.includes('[API isolated]'));
    }, isolatedId);
    pass('UI creates isolated agent and selects it in chat dropdown', isolatedId);

    const agentDir = join(stateDir, 'agents', isolatedId);
    const workspaceDir = join(agentDir, 'workspace');
    const configPath = join(agentDir, 'config.json');
    const config = readJson(configPath);
    assert(existsSync(join(workspaceDir, 'SOUL.md')), 'SOUL.md missing');
    assert(existsSync(join(workspaceDir, 'WhoAmI.md')), 'WhoAmI.md missing');
    assert(existsSync(join(workspaceDir, 'MyHuman.md')), 'MyHuman.md missing');
    assert(config.surface === 'api', 'surface should be api');
    assert(config.visibility === 'api_only', 'visibility should be api_only');
    assert(config.visibleInTeam === false, 'visibleInTeam should be false');
    assert(config.autoLinkTeam === false, 'autoLinkTeam should be false');
    pass('isolated agent config and identity files are created');

    assert(Array.isArray(config.agentMessaging?.allow), 'agentMessaging.allow missing');
    assert(config.agentMessaging.allow.length === 0, 'agentMessaging.allow should be empty');
    assert(config.agentMessaging.maxDepth === 0, 'maxDepth should be 0');
    assert(config.agentMessaging.maxCallsPerTurn === 0, 'maxCallsPerTurn should be 0');
    pass('isolated agent cannot delegate to other agents');

    const visibleAgents = await jsonFetch(baseUrl, '/api/agents');
    const allAgents = await jsonFetch(baseUrl, '/api/agents?includeHidden=1');
    assert(!visibleAgents.agents.some((a) => a.id === isolatedId), 'isolated leaked into /api/agents team pool');
    assert(visibleAgents.agents.some((a) => a.id === normalId), 'normal peer missing from /api/agents team pool');
    const allRow = allAgents.agents.find((a) => a.id === isolatedId);
    assert(allRow?.apiOnly === true, 'includeHidden row missing apiOnly metadata');
    assert(allRow?.visibleInTeam === false, 'includeHidden row should mark visibleInTeam=false');
    pass('isolated agent is hidden from backend team/delegation pool but visible to UI admin data');

    const mainConfig = await jsonFetch(baseUrl, '/api/agents/main/config');
    const mainAllow = Array.isArray(mainConfig.agentMessaging?.allow) ? mainConfig.agentMessaging.allow : [];
    assert(!mainAllow.includes(isolatedId), 'main config explicitly links to isolated agent');
    pass('main agent has no explicit link to isolated agent');

    await page.goto(baseUrl + '/team', { waitUntil: 'networkidle' });
    await page.waitForFunction((id) => {
      return [...document.querySelectorAll('.agent-map-node')]
        .some((node) => node.getAttribute('data-agent-id') === id && node.textContent.includes('API isolated'));
    }, isolatedId);
    pass('Team UI renders isolated agent with API-isolated badge');

    await page.goto(baseUrl + '/home', { waitUntil: 'networkidle' });
    await page.selectOption('#chat-agent-select', isolatedId);
    await page.fill('#chat-input', 'new session');
    await page.click('#chat-send');
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('.chat-msg.assistant')]
        .some((node) => node.textContent.includes('New session started.'));
    });
    pass('isolated agent is usable from normal dashboard chat UI without live LLM call');

    const sessionsPath = join(stateDir, 'chat-sessions', 'state.json');
    const sessions = readJson(sessionsPath);
    const isolatedSessionKeys = Object.keys(sessions).filter((key) => key.startsWith(`api:${isolatedId}:`));
    assert(isolatedSessionKeys.length === 1, `expected one api:${isolatedId}: session key, got ${isolatedSessionKeys.join(', ')}`);

    const isolatedRows = listJsonlRows(join(workspaceDir, 'chat-log', 'private'));
    assert(isolatedRows.some((row) =>
      String(row.jid || '').startsWith(`api:${isolatedId}:`) &&
      row.user === 'new session' &&
      row.assistant === 'New session started.'
    ), 'isolated workspace log missing API chat exchange');

    const mainRows = listJsonlRows(mainPrivateDir);
    assert(mainRows.some((row) => String(row.user || '').includes('secret code 9911')), 'seeded main history missing');
    assert(!mainRows.some((row) => String(row.jid || '').startsWith(`api:${isolatedId}:`)), 'isolated API exchange leaked into main workspace logs');
    pass('isolated chat uses api:<agent>:<conversation> session/logs under its own workspace');

    assert(consoleErrors.length === 0, 'browser console errors: ' + consoleErrors.join(' | '));
    pass('browser console has no errors during isolated-agent flow');

    console.log('\nSummary');
    console.log('- Works: UI create, UI visibility, normal chat selector use, isolated API chat route, isolated logs/sessions, no delegation links.');
    console.log('- Not tested with live LLM: natural-language answer quality. The chat route was exercised with "new session" to avoid live model calls.');
  } catch (err) {
    fail('isolated-agent UI flow', err);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
    if (process.env.PASTURE_KEEP_TEST_STATE !== '1') {
      rmSync(stateDir, { recursive: true, force: true });
    } else {
      console.log('Kept test state:', stateDir);
    }
  }

  const failed = rows.filter((row) => !row.ok);
  console.log('\nResult');
  console.log(`Passed: ${rows.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('\nIsolated agent UI test failed:', err?.message || err);
  process.exit(1);
});
