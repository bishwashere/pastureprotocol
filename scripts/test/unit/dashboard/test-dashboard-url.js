#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveDashboardUrl, DEFAULT_DASHBOARD_PORT } from '../../../../lib/util/dashboard-url.js';
import { executeGoRead } from '../../../../lib/agent/executors/go-read.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-dashboard-url-test-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  process.env.PASTURE_STATE_DIR = stateDir;
  return stateDir;
}

async function main() {
  const prevStateDir = process.env.PASTURE_STATE_DIR;
  const prevHost = process.env.PASTURE_DASHBOARD_HOST;
  const prevPort = process.env.PASTURE_DASHBOARD_PORT;

  try {
    delete process.env.PASTURE_DASHBOARD_HOST;
    delete process.env.PASTURE_DASHBOARD_PORT;

    const stateDir = setupStateDir();
    writeFileSync(join(stateDir, 'config.json'), '{}', 'utf8');

    const fallback = resolveDashboardUrl({ route: '/brain' });
    assert(fallback.url === `http://127.0.0.1:${DEFAULT_DASHBOARD_PORT}/brain`, 'uses source default dashboard URL');
    assert(fallback.sources.port.includes('DEFAULT_DASHBOARD_PORT'), 'default port source is recorded');

    writeFileSync(join(stateDir, '.env'), 'PASTURE_DASHBOARD_HOST=0.0.0.0\nPASTURE_DASHBOARD_PORT=4444\n', 'utf8');
    const envFile = resolveDashboardUrl({ route: 'brain' });
    assert(envFile.url === 'http://0.0.0.0:4444/brain', 'uses state .env dashboard URL');
    assert(envFile.sources.port.includes('.env'), 'env file port source is recorded');

    process.env.PASTURE_DASHBOARD_HOST = '127.0.0.2';
    process.env.PASTURE_DASHBOARD_PORT = '5555';
    const processEnv = resolveDashboardUrl({ route: '/brain' });
    assert(processEnv.url === 'http://127.0.0.2:5555/brain', 'process env overrides state .env');

    delete process.env.PASTURE_DASHBOARD_HOST;
    delete process.env.PASTURE_DASHBOARD_PORT;
    writeFileSync(join(stateDir, '.env'), '', 'utf8');
    writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ dashboard: { host: '127.0.0.3', port: 6666 } }), 'utf8');
    const config = resolveDashboardUrl({ route: '/brain' });
    assert(config.url === 'http://127.0.0.3:6666/brain', 'optional config dashboard URL is supported');

    const skillRaw = await executeGoRead({ workspaceDir: join(stateDir, 'workspace') }, {
      action: 'dashboard_url',
      route: '/brain',
    });
    const skill = JSON.parse(skillRaw);
    assert(skill.url === 'http://127.0.0.3:6666/brain', 'go-read dashboard_url returns resolved URL');

    console.log('dashboard-url tests passed');
  } finally {
    if (prevStateDir === undefined) delete process.env.PASTURE_STATE_DIR;
    else process.env.PASTURE_STATE_DIR = prevStateDir;
    if (prevHost === undefined) delete process.env.PASTURE_DASHBOARD_HOST;
    else process.env.PASTURE_DASHBOARD_HOST = prevHost;
    if (prevPort === undefined) delete process.env.PASTURE_DASHBOARD_PORT;
    else process.env.PASTURE_DASHBOARD_PORT = prevPort;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
