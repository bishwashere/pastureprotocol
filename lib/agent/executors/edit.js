/**
 * Edit skill: replace exact string in file. Fails if no match.
 */

import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { resolveWorkspacePath } from '../../util/workspace-path.js';
import { verifyFileEquals } from './file-verification.js';

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { path, oldString, newString }
 */
export async function executeEdit(ctx, args) {
  const pathArg = args?.path && String(args.path).trim();
  if (!pathArg) return JSON.stringify({ error: 'path is required.' });

  const oldString = args?.oldString;
  const newString = args?.newString != null ? String(args.newString) : '';
  if (oldString === undefined || oldString === null) {
    return JSON.stringify({ error: 'oldString is required.' });
  }
  const oldStr = String(oldString);

  const workspaceDir = ctx.workspaceDir || '';
  const { resolved, pathArg: displayPath } = resolveWorkspacePath(workspaceDir, pathArg);

  if (!existsSync(resolved)) {
    return JSON.stringify({ error: `File not found: ${displayPath}` });
  }

  try {
    const content = readFileSync(resolved, 'utf8');
    if (!content.includes(oldStr)) {
      return JSON.stringify({
        error: 'No exact match for oldString in file. Edit not applied.',
        path: displayPath,
      });
    }
    const parts = content.split(oldStr);
    const count = parts.length - 1;
    const newContent = parts.join(newString);
    writeFileSync(resolved, newContent, 'utf8');
    const verification = verifyFileEquals(resolved, newContent, 'edit');
    if (!verification.verified) {
      return JSON.stringify({
        error: 'Edit verification failed: file content on disk does not match edited content.',
        path: displayPath,
        verification,
      });
    }
    return JSON.stringify({
      path: displayPath,
      replaced: true,
      count,
      verification,
    });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
