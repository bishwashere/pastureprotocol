/**
 * Home Assistant executor: runs the ha-cli.js CLI with the given command or legacy args.
 * Lives in the skill folder with the CLI; all HA execution (API + token) is in the CLI layer.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getStateDir } from '../../lib/util/paths.js';
import { enrichHaToolResult } from '../../lib/integrations/home-assistant-format.js';
import { spawnWithTimeout } from '../../lib/agent/executors/spawn-with-timeout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to ha-cli.js in this skill folder. */
function getHaCliPath() {
  return join(__dirname, 'ha-cli.js');
}

/** Install/repo root (so CLI can resolve ../../lib when run). */
function getInstallRoot() {
  return process.env.PASTURE_INSTALL_DIR || join(__dirname, '..', '..');
}

/**
 * Build argv for ha-cli.js from LLM args. Supports:
 * - command (string): "list lights", "search kitchen", "on light.living_room", "list automations", etc.
 * - Legacy: action + domain + entity_id + service + service_data
 */
function buildCliArgs(args) {
  const cmd = (args?.command && String(args.command).trim()) || (args?.action && String(args.action).trim()) || '';
  if (cmd) {
    const parts = cmd.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
  }

  const action = (args?.action && String(args.action).trim()) || '';
  const act = action.toLowerCase().replace(/\s+/g, '_');
  const domain = (args?.domain && String(args.domain).trim()) || '';
  const entityId = args?.entity_id != null ? String(args.entity_id).trim() : '';
  const service = (args?.service && String(args.service).trim()) || '';
  const serviceData = args?.service_data && typeof args.service_data === 'object' ? args.service_data : null;

  if (act === 'list_states' || act === 'list') return ['list', domain];
  if (act === 'get_state') return entityId ? ['state', entityId] : [];
  if (act === 'call_service' || act === 'call' || act === 'service') {
    if (domain && service) {
      const serviceDataStr = serviceData && Object.keys(serviceData).length > 0 ? JSON.stringify(serviceData) : '';
      const base = ['call', domain, service];
      if (entityId) base.push(entityId);
      else if (serviceDataStr) base.push('');
      if (serviceDataStr) base.push(serviceDataStr);
      return base;
    }
  }
  return [];
}

/**
 * Run the HA CLI and return its stdout (JSON string).
 * @param {string[]} argv - Arguments for ha-cli.js (e.g. ['list', 'lights'])
 * @returns {Promise<string>}
 */
async function runCli(argv) {
  const cliPath = getHaCliPath();
  const cwd = getInstallRoot();
  const env = { ...process.env, PASTURE_STATE_DIR: getStateDir() };
  const result = await spawnWithTimeout(process.execPath, [cliPath, ...argv], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.timedOut) {
    return JSON.stringify({ error: result.error || 'Home Assistant CLI timed out.' });
  }
  if (result.error && !result.code && !result.stdout && !result.stderr) {
    return JSON.stringify({ error: result.error });
  }
  const out = (result.stdout.trim() || result.stderr.trim());
  if (!result.ok) {
    try {
      const parsed = JSON.parse(out);
      if (parsed.error) return JSON.stringify(parsed);
    } catch (_) {}
    return JSON.stringify({ error: out || `CLI exited with code ${result.code}` });
  }
  return out || '{}';
}

/**
 * @param {object} ctx - { workspaceDir, jid, ... }
 * @param {object} args - command (e.g. "list lights") or action/domain/entity_id/service/service_data
 */
export async function executeHomeAssistant(ctx, args) {
  const argv = buildCliArgs(args);
  if (argv.length === 0) {
    return JSON.stringify({
      error: 'Provide a command (e.g. "list lights", "search kitchen", "on light.living_room") or action + domain/entity_id. Use "help" for all commands.',
    });
  }
  return enrichHaToolResult(await runCli(argv));
}
