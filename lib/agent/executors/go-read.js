/**
 * Go read: list and read from the filesystem only (ls, cd, pwd, cat, less, du).
 */

import { runAllowlisted } from './run-allowlisted.js';
import { resolveDashboardUrl } from '../../util/dashboard-url.js';

const ALLOWED = new Set(['ls', 'cd', 'pwd', 'cat', 'less', 'du']);

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 */
export async function executeGoRead(ctx, args) {
  const action = String(args?.action || args?.command || '').trim().toLowerCase();
  if (action === 'dashboard_url' || action === 'dashboard-url') {
    return JSON.stringify(resolveDashboardUrl({ route: args?.route || '' }), null, 2);
  }
  return runAllowlisted(ctx, args, ALLOWED);
}
