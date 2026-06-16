/**
 * Server registry for ssh-inspect: read/write named host entries in config.json.
 * Stored under config.skills["ssh-inspect"].hosts as { [name]: { hostname, user?, key? } }.
 * Active server stored under config.skills["ssh-inspect"].activeServer.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getConfigPath, ensureStateDir } from './paths.js';

function loadConfig() {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  ensureStateDir();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

function getHosts(config) {
  return (config.skills?.['ssh-inspect']?.hosts) || {};
}

/**
 * Register (add or update) a named server entry.
 * @param {string} name - Registry name (e.g. "atlas", "prod")
 * @param {string} hostname - IP or DNS hostname
 * @param {{ user?: string, key?: string, alias?: string }} [opts]
 * @returns {{ ok: boolean, message: string }}
 */
export function registerServer(name, hostname, opts = {}) {
  if (!name || !hostname) {
    return { ok: false, message: 'Both name and hostname are required.' };
  }

  const safeName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const config = loadConfig();
  config.skills = config.skills || {};
  config.skills['ssh-inspect'] = config.skills['ssh-inspect'] || {};
  config.skills['ssh-inspect'].hosts = config.skills['ssh-inspect'].hosts || {};

  const entry = { hostname: hostname.trim() };
  if (opts.user) entry.user = opts.user.trim();
  if (opts.key) entry.key = opts.key.trim();
  if (opts.alias) entry.alias = opts.alias.trim();

  const isUpdate = !!config.skills['ssh-inspect'].hosts[safeName];
  config.skills['ssh-inspect'].hosts[safeName] = entry;
  saveConfig(config);

  const aliasSuffix = entry.alias ? ` [alias: ${entry.alias}]` : '';
  return {
    ok: true,
    message: isUpdate
      ? `Updated server "${safeName}" → ${entry.hostname}${entry.user ? ` (user: ${entry.user})` : ''}${aliasSuffix}.`
      : `Registered server "${safeName}" → ${entry.hostname}${entry.user ? ` (user: ${entry.user})` : ''}${aliasSuffix}.`,
  };
}

/**
 * Remove a named server entry.
 * @param {string} name
 * @returns {{ ok: boolean, message: string }}
 */
export function removeServer(name) {
  const safeName = (name || '').trim().toLowerCase();
  if (!safeName) return { ok: false, message: 'Name is required.' };

  const config = loadConfig();
  const hosts = config.skills?.['ssh-inspect']?.hosts;
  if (!hosts || !hosts[safeName]) {
    return { ok: false, message: `Server "${safeName}" not found in registry.` };
  }

  delete hosts[safeName];
  saveConfig(config);
  return { ok: true, message: `Removed server "${safeName}".` };
}

/**
 * List all registered servers.
 * @returns {Array<{ name: string, hostname: string, user?: string, key?: string }>}
 */
export function listServers() {
  const config = loadConfig();
  const hosts = getHosts(config);
  return Object.entries(hosts).map(([name, entry]) => ({ name, ...entry }));
}

/**
 * Resolve a server name to its config entry, or return null if not found.
 * Also returns the original value as a passthrough if not in registry.
 * @param {string} nameOrHost
 * @returns {{ hostname: string, user?: string, key?: string } | null}
 */
export function resolveServer(nameOrHost) {
  const config = loadConfig();
  const hosts = getHosts(config);
  const key = (nameOrHost || '').trim().toLowerCase();
  return hosts[key] || null;
}

/**
 * Get the active server name (set via `pasture server use`).
 * @returns {string|null}
 */
export function getActiveServer() {
  const config = loadConfig();
  return config.skills?.['ssh-inspect']?.activeServer || null;
}

/**
 * Set the active server name.
 * @param {string} name
 * @returns {{ ok: boolean, message: string }}
 */
export function setActiveServer(name) {
  const safeName = (name || '').trim().toLowerCase();
  if (!safeName) return { ok: false, message: 'Name is required.' };

  const config = loadConfig();
  const hosts = getHosts(config);
  if (!hosts[safeName]) {
    return { ok: false, message: `Server "${safeName}" is not in the registry. Add it first with: pasture server add <ip> ${safeName}` };
  }

  config.skills = config.skills || {};
  config.skills['ssh-inspect'] = config.skills['ssh-inspect'] || {};
  config.skills['ssh-inspect'].activeServer = safeName;
  saveConfig(config);
  return { ok: true, message: `Active server set to "${safeName}". SSH commands will default to this server.` };
}
