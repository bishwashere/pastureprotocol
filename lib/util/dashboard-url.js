import { existsSync, readFileSync } from 'fs';
import { parse as parseDotenv } from 'dotenv';
import { getConfigPath, getEnvPath } from './paths.js';

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 3847;

function readJsonFile(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function cleanHost(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function cleanPort(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? String(n) : '';
}

function cleanRoute(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return '/' + s.replace(/^\/+/, '');
}

function configDashboardValue(config, key) {
  const dash = config?.dashboard && typeof config.dashboard === 'object' ? config.dashboard : {};
  const dashboardUpper = key === 'host' ? 'PASTURE_DASHBOARD_HOST' : 'PASTURE_DASHBOARD_PORT';
  const dashboardCamel = key === 'host' ? 'dashboardHost' : 'dashboardPort';
  return dash[key] ?? config?.[dashboardCamel] ?? config?.[dashboardUpper];
}

export function resolveDashboardUrl({ route = '' } = {}) {
  const envFile = readEnvFile(getEnvPath());
  const config = readJsonFile(getConfigPath());

  const hostCandidates = [
    { value: process.env.PASTURE_DASHBOARD_HOST, source: 'process.env.PASTURE_DASHBOARD_HOST' },
    { value: envFile.PASTURE_DASHBOARD_HOST, source: `${getEnvPath()}:PASTURE_DASHBOARD_HOST` },
    { value: configDashboardValue(config, 'host'), source: `${getConfigPath()}:dashboard.host` },
    { value: DEFAULT_DASHBOARD_HOST, source: 'source default DEFAULT_DASHBOARD_HOST' },
  ];
  const portCandidates = [
    { value: process.env.PASTURE_DASHBOARD_PORT, source: 'process.env.PASTURE_DASHBOARD_PORT' },
    { value: envFile.PASTURE_DASHBOARD_PORT, source: `${getEnvPath()}:PASTURE_DASHBOARD_PORT` },
    { value: configDashboardValue(config, 'port'), source: `${getConfigPath()}:dashboard.port` },
    { value: DEFAULT_DASHBOARD_PORT, source: 'source default DEFAULT_DASHBOARD_PORT' },
  ];

  const hostPick = hostCandidates
    .map((c) => ({ ...c, value: cleanHost(c.value) }))
    .find((c) => c.value);
  const portPick = portCandidates
    .map((c) => ({ ...c, value: cleanPort(c.value) }))
    .find((c) => c.value);

  const host = hostPick?.value || DEFAULT_DASHBOARD_HOST;
  const port = portPick?.value || String(DEFAULT_DASHBOARD_PORT);
  const normalizedRoute = cleanRoute(route);
  return {
    ok: true,
    host,
    port: Number(port),
    baseUrl: `http://${host}:${port}`,
    url: `http://${host}:${port}${normalizedRoute}`,
    route: normalizedRoute,
    sources: {
      host: hostPick?.source || 'source default DEFAULT_DASHBOARD_HOST',
      port: portPick?.source || 'source default DEFAULT_DASHBOARD_PORT',
    },
    checked: [
      'process.env.PASTURE_DASHBOARD_HOST',
      'process.env.PASTURE_DASHBOARD_PORT',
      `${getEnvPath()}:PASTURE_DASHBOARD_HOST`,
      `${getEnvPath()}:PASTURE_DASHBOARD_PORT`,
      `${getConfigPath()}:dashboard.host`,
      `${getConfigPath()}:dashboard.port`,
      'source defaults',
    ],
  };
}
