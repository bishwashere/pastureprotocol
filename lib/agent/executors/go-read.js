/**
 * Go read: list and read from the filesystem only (ls, cd, pwd, cat, less, du).
 */

import { runAllowlisted } from './run-allowlisted.js';

const ALLOWED = new Set(['ls', 'cd', 'pwd', 'cat', 'less', 'du']);

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 */
export async function executeGoRead(ctx, args) {
  return runAllowlisted(ctx, args, ALLOWED);
}
