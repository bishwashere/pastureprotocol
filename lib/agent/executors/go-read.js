/**
 * Go read: list/read from the filesystem and run read-only local inspection queries.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { runAllowlisted } from './run-allowlisted.js';
import { resolveDashboardUrl } from '../../util/dashboard-url.js';
import { getMemoryIndexPath } from '../../util/paths.js';

const ALLOWED = new Set(['ls', 'cd', 'pwd', 'cat', 'less', 'du']);

function resolveSqlitePath(args) {
  let indexPath = args?.path && String(args.path).trim();
  if (!indexPath) indexPath = getMemoryIndexPath();
  if (indexPath.startsWith('~/') || indexPath === '~') {
    indexPath = join(homedir(), indexPath.slice(1));
  }
  return indexPath;
}

function sqliteParams(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  return [];
}

function runStatement(statement, params) {
  if (Array.isArray(params)) return statement.all(...params);
  return statement.all(params);
}

function executeSqlRead(args) {
  const indexPath = resolveSqlitePath(args);
  if (!existsSync(indexPath)) {
    return { error: `SQLite database not found: ${indexPath}` };
  }

  const sql = args?.sql || args?.query;
  const query = sql && String(sql).trim();
  if (!query) return { error: 'sql query is required.' };

  const maxRowsRaw = args?.maxRows ?? args?.limit ?? 200;
  const maxRows = Math.min(1000, Math.max(1, parseInt(maxRowsRaw, 10) || 200));
  const params = sqliteParams(args?.params);
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    const statement = db.prepare(query);
    if (!statement.readonly) {
      return { error: 'Only read-only SQL is allowed.' };
    }
    const rows = runStatement(statement, params);
    const limitedRows = rows.slice(0, maxRows);
    return {
      path: indexPath,
      sql: query,
      readonly: true,
      rowCount: rows.length,
      returnedRows: limitedRows.length,
      truncated: rows.length > limitedRows.length,
      rows: limitedRows,
    };
  } finally {
    db.close();
  }
}

/**
 * @param {object} ctx - { workspaceDir }
 * @param {object} args - { command | action, argv?, cwd? }
 */
export async function executeGoRead(ctx, args) {
  const action = String(args?.action || args?.command || '').trim().toLowerCase();
  if (action === 'dashboard_url' || action === 'dashboard-url') {
    return JSON.stringify(resolveDashboardUrl({ route: args?.route || '' }), null, 2);
  }
  if (action === 'sql' || action === 'sqlite' || action === 'query') {
    try {
      return JSON.stringify(executeSqlRead(args), null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
  return runAllowlisted(ctx, args, ALLOWED);
}
