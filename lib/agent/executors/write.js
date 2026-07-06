/**
 * Write skill: create or replace a file with given content.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { resolveWorkspacePath } from '../../util/workspace-path.js';
import { verifyFileEquals } from './file-verification.js';

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { path, content }
 */
export async function executeWrite(ctx, args) {
  const pathArg = args?.path && String(args.path).trim();
  if (!pathArg) return JSON.stringify({ error: 'path is required.' });

  const content = args?.content != null ? String(args.content) : '';
  const workspaceDir = ctx.workspaceDir || '';
  const { resolved, pathArg: displayPath } = resolveWorkspacePath(workspaceDir, pathArg);

  try {
    const dir = dirname(resolved);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(resolved, content, 'utf8');
    const verification = verifyFileEquals(resolved, content, 'write');
    if (!verification.verified) {
      return JSON.stringify({
        error: 'Write verification failed: file content on disk does not match requested content.',
        path: displayPath,
        verification,
      });
    }
    return JSON.stringify({
      path: displayPath,
      written: true,
      size: Buffer.byteLength(content, 'utf8'),
      verification,
    });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
