/**
 * Go read: list/read from the filesystem and run read-only local inspection queries.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
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

function openReadonlyDb(indexPath) {
  const db = new Database(indexPath, { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
  } catch (_) {
    // Not every SQLite DB needs sqlite-vec; leave ordinary read-only inspection usable.
  }
  db.pragma('query_only = ON');
  return db;
}

function listSchema(db, sampleRows) {
  const tables = db.prepare(`
    SELECT name, type, sql
    FROM sqlite_master
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();

  return tables.map((table) => {
    let columns = [];
    try {
      columns = db.prepare(`PRAGMA table_xinfo(${JSON.stringify(table.name)})`).all().map((column) => ({
        cid: column.cid,
        name: column.name,
        type: column.type,
        notnull: Boolean(column.notnull),
        pk: column.pk,
        hidden: column.hidden,
      }));
    } catch (err) {
      columns = [{ error: err.message || String(err) }];
    }

    let sample = [];
    let sampleError = null;
    if (sampleRows > 0 && table.type === 'table' && !table.name.includes('_vec')) {
      try {
        sample = db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}" LIMIT ?`).all(sampleRows);
      } catch (err) {
        sampleError = err.message || String(err);
      }
    }

    return {
      name: table.name,
      type: table.type,
      columns,
      createSql: table.sql,
      sample,
      ...(sampleError ? { sampleError } : {}),
    };
  });
}

function executeSqlSchema(args) {
  const indexPath = resolveSqlitePath(args);
  if (!existsSync(indexPath)) {
    return { error: `SQLite database not found: ${indexPath}` };
  }

  const sampleRowsRaw = args?.sampleRows ?? args?.samples ?? 3;
  const sampleRows = Math.min(10, Math.max(0, parseInt(sampleRowsRaw, 10) || 0));
  const db = openReadonlyDb(indexPath);
  try {
    return {
      path: indexPath,
      readonly: true,
      sampleRows,
      tables: listSchema(db, sampleRows),
    };
  } finally {
    db.close();
  }
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
  const db = openReadonlyDb(indexPath);
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
  } catch (err) {
    return {
      error: err.message || String(err),
      path: indexPath,
      sql: query,
      readonly: true,
      schemaHint: 'Run go-read with action "sql_schema" for tables, columns, create SQL, and sample rows; then retry with corrected read-only SQL.',
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
  if (action === 'sql_schema' || action === 'sql-schema' || action === 'schema') {
    try {
      return JSON.stringify(executeSqlSchema(args), null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
  return runAllowlisted(ctx, args, ALLOWED);
}
