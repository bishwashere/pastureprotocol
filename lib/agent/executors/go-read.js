/**
 * Go read: list/read from the filesystem and run read-only local inspection queries.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { expandTilde, runAllowlisted } from './run-allowlisted.js';
import { resolveDashboardUrl } from '../../util/dashboard-url.js';
import { getMemoryIndexPath } from '../../util/paths.js';

const ALLOWED = new Set(['ls', 'cd', 'pwd', 'cat', 'less', 'du', 'find']);
const MAX_JSON_BYTES = 5_000_000;
const MAX_JSON_SUMMARIES = 20;

const PRIMARY_FIELD_NAMES = new Set([
  'text',
  'label',
  'name',
  'title',
  'term',
  'word',
  'phrase',
  'content',
  'body',
  'summary',
  'description',
  'value',
]);

const MEASURE_FIELD_NAMES = new Set([
  'weight',
  'score',
  'rank',
  'count',
  'frequency',
  'importance',
  'strength',
  'total',
  'size',
]);

const METADATA_FIELD_NAMES = new Set([
  'path',
  'file',
  'filename',
  'source',
  'type',
  'line',
  'line_start',
  'line_end',
  'start',
  'end',
  'chunk',
  'chunk_id',
  'metadata',
]);

const LOW_VALUE_FIELD_NAMES = new Set([
  'id',
  '_id',
  'uuid',
  'embedding',
  'vector',
]);

function normalizedFieldName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function fieldPriority(name) {
  const normalized = normalizedFieldName(name);
  if (PRIMARY_FIELD_NAMES.has(normalized)) return 0;
  if (MEASURE_FIELD_NAMES.has(normalized)) return 1;
  if (normalized.endsWith('_text') || normalized.endsWith('_label') || normalized.endsWith('_name')) return 0;
  if (normalized.endsWith('_score') || normalized.endsWith('_weight') || normalized.endsWith('_count')) return 1;
  if (METADATA_FIELD_NAMES.has(normalized)) return 3;
  if (LOW_VALUE_FIELD_NAMES.has(normalized)) return 4;
  if (normalized.endsWith('_id') || normalized.includes('embedding') || normalized.includes('vector')) return 4;
  return 2;
}

function prioritizeStructuredRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const keys = Object.keys(row);
  const originalOrder = new Map(keys.map((key, index) => [key, index]));
  return Object.fromEntries(keys
    .sort((a, b) => {
      const priority = fieldPriority(a) - fieldPriority(b);
      if (priority !== 0) return priority;
      return originalOrder.get(a) - originalOrder.get(b);
    })
    .map((key) => [key, row[key]]));
}

function simplifyStructuredValue(value) {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const primitives = value.filter((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item));
    if (primitives.length === value.length) return primitives.slice(0, 10);
  }
  return undefined;
}

function simplifyStructuredRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const simplified = simplifyStructuredValue(value);
    if (simplified !== undefined) out[key] = simplified;
  }
  return prioritizeStructuredRow(out);
}

function summarizeJsonArray(path, arr, maxItems) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const objectItems = arr.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (objectItems.length === 0) {
    return {
      jsonPath: path,
      totalItems: arr.length,
      items: arr.slice(0, maxItems),
    };
  }
  return {
    jsonPath: path,
    totalItems: arr.length,
    items: objectItems.slice(0, maxItems).map(simplifyStructuredRow),
  };
}

function collectJsonSummaries(value, path, maxItems, summaries, emptyArrays) {
  if (summaries.length >= MAX_JSON_SUMMARIES) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      emptyArrays.push(path);
      return;
    }
    const summary = summarizeJsonArray(path, value, maxItems);
    if (summary) summaries.push(summary);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    collectJsonSummaries(child, childPath, maxItems, summaries, emptyArrays);
    if (summaries.length >= MAX_JSON_SUMMARIES) break;
  }
}

function executeJsonRead(args) {
  let jsonPath = args?.path && String(args.path).trim();
  if (!jsonPath && Array.isArray(args?.argv) && args.argv[0]) jsonPath = String(args.argv[0]).trim();
  if (!jsonPath) return { error: 'json path is required.' };
  jsonPath = expandTilde(jsonPath);
  if (!existsSync(jsonPath)) return { error: `JSON file not found: ${jsonPath}` };

  const raw = readFileSync(jsonPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_JSON_BYTES) {
    return { error: `JSON file is too large for structured read: ${jsonPath}` };
  }
  const parsed = JSON.parse(raw);
  const maxItemsRaw = args?.maxItems ?? args?.limit ?? 10;
  const maxItems = Math.min(50, Math.max(1, parseInt(maxItemsRaw, 10) || 10));
  const summaries = [];
  const emptyArrays = [];
  collectJsonSummaries(parsed, '', maxItems, summaries, emptyArrays);
  return {
    path: jsonPath,
    json: true,
    primaryData: summaries,
    emptyArrays: emptyArrays.slice(0, 20),
    note: 'primaryData surfaces arrays with user-facing fields first; ids, paths, chunks, embeddings, vectors, and provenance are helper metadata.',
  };
}

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
        sample = db.prepare(`SELECT * FROM "${table.name.replace(/"/g, '""')}" LIMIT ?`).all(sampleRows)
          .map(prioritizeStructuredRow);
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
    const limitedRows = rows.slice(0, maxRows).map(prioritizeStructuredRow);
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
  if (action === 'json' || action === 'json_read' || action === 'json-read') {
    try {
      return JSON.stringify(executeJsonRead(args), null, 2);
    } catch (err) {
      return JSON.stringify({ error: err.message || String(err) });
    }
  }
  return runAllowlisted(ctx, args, ALLOWED);
}
