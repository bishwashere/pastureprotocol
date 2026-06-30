#!/usr/bin/env node
/**
 * Browser E2E: dashboard home loads status and chat toolbar clicks work.
 * Starts a temporary dashboard from this repo (workspace assets, not installed copy).
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { E2EReport } from '../../support/e2e-report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const report = new E2EReport('dashboard-browser-e2e');

function pickPort() {
  return 19000 + Math.floor(Math.random() * 1000);
}

async function waitForDashboard(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Dashboard not ready: ${url}`);
}

function startDashboardServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dashboard/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PASTURE_DASHBOARD_PORT: String(port), PASTURE_DASHBOARD_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code != null && code !== 0) {
        reject(new Error(`Dashboard exited ${code}: ${stderr.slice(-500)}`));
      }
    });
    resolve({ child, stderr: () => stderr });
  });
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (!msg.includes("Executable doesn't exist")) throw err;
    console.log('[dashboard-browser-e2e] Installing Playwright Chromium…');
    await new Promise((resolve, reject) => {
      const proc = spawn('npx', ['playwright', 'install', 'chromium'], {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
      });
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`playwright install exited ${code}`))));
    });
    return chromium.launch({ headless: true });
  }
}

async function runCase(name, input, fn) {
  try {
    const output = await fn();
    report.add({ name, input, output, status: 'pass' });
  } catch (err) {
    report.add({
      name,
      input,
      output: '',
      status: 'fail',
      detail: err && err.message ? err.message : String(err),
    });
  }
}

const port = pickPort();
const baseUrl = `http://127.0.0.1:${port}`;
let serverChild = null;
let browser = null;

try {
  const server = await startDashboardServer(port);
  serverChild = server.child;
  await waitForDashboard(`${baseUrl}/`);

  browser = await launchBrowser();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${baseUrl}/#home`, { waitUntil: 'networkidle', timeout: 30000 });

  await runCase(
    'home-status-loads',
    'Open #home, wait for daemon status text',
    async () => {
      await page.waitForFunction(() => {
        const el = document.getElementById('chat-status-text');
        return el && el.textContent && el.textContent.trim() !== 'Checking…';
      }, { timeout: 15000 });
      const text = await page.locator('#chat-status-text').textContent();
      if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.join('; ')}`);
      return text.trim();
    },
  );

  await runCase(
    'chat-plus-agent-opens-modal',
    'Click #chat-agent-create-btn',
    async () => {
      await page.locator('#chat-agent-create-btn').click();
      await page.waitForFunction(() =>
        document.getElementById('agent-create-modal')?.classList.contains('open'),
      { timeout: 5000 });
      const open = await page.locator('#agent-create-modal').evaluate((el) => el.classList.contains('open'));
      if (!open) throw new Error('Create agent modal did not open');
      return 'Create agent modal open';
    },
  );

  await runCase(
    'team-plus-agent-opens-modal',
    'Close modal, click #agent-team-create-btn',
    async () => {
      await page.evaluate(() => {
        if (typeof closeAgentCreateModal === 'function') closeAgentCreateModal();
      });
      await page.locator('#agent-team-create-btn').click();
      await page.waitForFunction(() =>
        document.getElementById('agent-create-modal')?.classList.contains('open'),
      { timeout: 5000 });
      return 'Team + Agent opened modal';
    },
  );

  await runCase(
    'chat-new-focuses-input',
    'Close modal, click #chat-new-btn',
    async () => {
      await page.evaluate(() => {
        if (typeof closeAgentCreateModal === 'function') closeAgentCreateModal();
      });
      await page.locator('#chat-new-btn').click();
      await page.waitForFunction(() => document.activeElement?.id === 'chat-input', { timeout: 3000 });
      return 'Chat input focused after New';
    },
  );

  await runCase(
    'chat-send-click-no-throw',
    'Click #chat-send with empty input (handler wired)',
    async () => {
      const before = pageErrors.length;
      await page.locator('#chat-send').click();
      await page.waitForTimeout(200);
      if (pageErrors.length > before) {
        throw new Error(`Page error on Send click: ${pageErrors.slice(before).join('; ')}`);
      }
      return 'Send click handled';
    },
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverChild) {
    serverChild.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!serverChild.killed) serverChild.kill('SIGKILL');
  }
}

report.print();
const failed = report.rows.filter((r) => r.status === 'fail').length;
process.exit(failed ? 1 : 0);
