/**
 * Go write: change the filesystem (cp, mv, rm, touch, chmod, mkdir).
 */

import { runAllowlisted } from './run-allowlisted.js';

const ALLOWED = new Set(['cp', 'mv', 'rm', 'touch', 'chmod', 'mkdir', 'rsync']);

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 */
export async function executeGoWrite(ctx, args) {
  return runAllowlisted(ctx, args, ALLOWED);
}
