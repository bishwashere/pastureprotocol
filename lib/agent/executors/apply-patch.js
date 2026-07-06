/**
 * Apply-patch skill: apply a Git-style diff hunk to a file.
 */

import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import { resolveWorkspacePath } from '../../util/workspace-path.js';
import { verifyFileEquals } from './file-verification.js';

/**
 * Parse a unified-diff-style hunk into old lines (to match) and new lines (to write).
 * Lines: " " = context, "-" = remove, "+" = add.
 * @param {string} hunk
 * @returns {{ oldLines: string[], newLines: string[] }}
 */
function parseHunk(hunk) {
  const lines = hunk.split(/\r?\n/);
  const oldLines = [];
  const newLines = [];
  for (const line of lines) {
    if (line.startsWith(' ')) {
      const content = line.slice(1);
      oldLines.push(content);
      newLines.push(content);
    } else if (line.startsWith('-')) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1));
    }
    // ignore other prefixes (e.g. @@ header)
  }
  return { oldLines, newLines };
}

/**
 * Find start index in file lines where oldLines match.
 * @param {string[]} fileLines
 * @param {string[]} oldLines
 * @returns {number} -1 if not found
 */
function findHunkStart(fileLines, oldLines) {
  if (oldLines.length === 0) return 0;
  const first = oldLines[0];
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    if (fileLines[i] !== first) continue;
    let match = true;
    for (let j = 1; j < oldLines.length; j++) {
      if (fileLines[i + j] !== oldLines[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { path, hunk }
 */
export async function executeApplyPatch(ctx, args) {
  const pathArg = args?.path && String(args.path).trim();
  if (!pathArg) return JSON.stringify({ error: 'path is required.' });

  const hunk = args?.hunk != null ? String(args.hunk) : '';
  if (!hunk.trim()) return JSON.stringify({ error: 'hunk is required.' });

  const workspaceDir = ctx.workspaceDir || '';
  const { resolved, pathArg: displayPath } = resolveWorkspacePath(workspaceDir, pathArg);

  if (!existsSync(resolved)) {
    return JSON.stringify({ error: `File not found: ${displayPath}` });
  }

  try {
    const { oldLines, newLines } = parseHunk(hunk);
    const content = readFileSync(resolved, 'utf8');
    const fileLines = content.split(/\r?\n/);
    const start = findHunkStart(fileLines, oldLines);
    if (start < 0) {
      return JSON.stringify({
        error: 'Hunk context does not match file. Patch not applied.',
        path: displayPath,
      });
    }
    const before = fileLines.slice(0, start);
    const after = fileLines.slice(start + oldLines.length);
    const newFileLines = [...before, ...newLines, ...after];
    const newContent = newFileLines.join('\n');
    writeFileSync(resolved, newContent, 'utf8');
    const verification = verifyFileEquals(resolved, newContent, 'apply_patch');
    if (!verification.verified) {
      return JSON.stringify({
        error: 'Patch verification failed: file content on disk does not match patched content.',
        path: displayPath,
        verification,
      });
    }
    return JSON.stringify({
      path: displayPath,
      applied: true,
      startLine: start + 1,
      oldLineCount: oldLines.length,
      newLineCount: newLines.length,
      verification,
    });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
