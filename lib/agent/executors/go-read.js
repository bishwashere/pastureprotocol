/**
 * Go read: list/read from the filesystem and run read-only local inspection queries.
 */

import { spawn } from 'child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { expandTilde } from './run-allowlisted.js';
import { resolveDashboardUrl } from '../../util/dashboard-url.js';
import { getMemoryIndexPath } from '../../util/paths.js';

const ALLOWED = new Set(['ls', 'cd', 'pwd', 'cat', 'less', 'du', 'find']);
const MAX_JSON_BYTES = 5_000_000;
const MAX_JSON_SUMMARIES = 20;
const MAX_TEXT_OUTPUT_CHARS = 50_000;
const NPM_TIMEOUT_MS = 5 * 60_000;

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

function limitTextOutput(text) {
  const out = String(text || '').trimEnd();
  if (out.length <= MAX_TEXT_OUTPUT_CHARS) return out;
  return out.slice(0, MAX_TEXT_OUTPUT_CHARS) + '\n[... truncated]';
}

function resolveReadCwd(ctx, args) {
  const base = ctx?.workspaceDir || process.cwd();
  const raw = args?.cwd ? expandTilde(String(args.cwd)) : base;
  return resolve(raw);
}

function resolveReadPath(cwd, input) {
  const raw = input == null || input === '' ? '.' : String(input);
  return resolve(cwd, expandTilde(raw));
}

function splitFlagsAndValues(argv) {
  const flags = [];
  const values = [];
  for (const item of Array.isArray(argv) ? argv : []) {
    const value = String(item);
    if (value.startsWith('-') && value !== '-') flags.push(value);
    else values.push(value);
  }
  return { flags, values };
}

function compactFlags(flags) {
  return flags.join('');
}

function modeString(stat) {
  const type = stat.isDirectory() ? 'd' : stat.isSymbolicLink() ? 'l' : '-';
  const modes = [
    0o400, 0o200, 0o100,
    0o040, 0o020, 0o010,
    0o004, 0o002, 0o001,
  ];
  const chars = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  return type + modes.map((bit, index) => (stat.mode & bit ? chars[index] : '-')).join('');
}

function formatBytes(bytes, human) {
  const n = Number(bytes) || 0;
  if (!human) return String(n);
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded}${units[unit]}`;
}

function mtimeString(stat) {
  return stat.mtime.toISOString().replace('T', ' ').slice(0, 16);
}

function listOne(cwd, target, flags) {
  const full = resolveReadPath(cwd, target);
  if (!existsSync(full)) return { error: `Path not found: ${target || '.'}` };
  const flagText = compactFlags(flags);
  const showAll = flagText.includes('a');
  const long = flagText.includes('l');
  const human = flagText.includes('h');
  const stat = lstatSync(full);
  const entries = stat.isDirectory()
    ? readdirSync(full, { withFileTypes: true })
      .filter((entry) => showAll || !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(full, entry.name) }))
    : [{ name: basename(full), path: full }];

  const lines = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const entryStat = lstatSync(entry.path);
      const name = entryStat.isDirectory() ? `${entry.name}/` : entry.name;
      if (!long) return name;
      return `${modeString(entryStat)} ${formatBytes(entryStat.size, human).padStart(8)} ${mtimeString(entryStat)} ${name}`;
    });
  return { text: lines.join('\n') };
}

function executeNativeLs(ctx, args) {
  const cwd = resolveReadCwd(ctx, args);
  const { flags, values } = splitFlagsAndValues(args?.argv);
  const targets = values.length ? values : ['.'];
  const chunks = [];
  for (const target of targets) {
    const result = listOne(cwd, target, flags);
    if (result.error) return JSON.stringify({ error: result.error });
    if (targets.length > 1) chunks.push(`${target}:`);
    chunks.push(result.text);
  }
  return limitTextOutput(chunks.join('\n'));
}

function executeNativePwd(ctx, args) {
  return resolveReadCwd(ctx, args);
}

function executeNativeCd(ctx, args) {
  const cwd = resolveReadCwd(ctx, args);
  const argv = Array.isArray(args?.argv) ? args.argv : [];
  const target = resolveReadPath(cwd, argv[0] || '.');
  if (!existsSync(target)) return JSON.stringify({ error: `Directory not found: ${argv[0] || '.'}` });
  const stat = lstatSync(target);
  if (!stat.isDirectory()) return JSON.stringify({ error: `Not a directory: ${argv[0] || '.'}` });
  return target;
}

function readFiles(cwd, argv) {
  const files = (Array.isArray(argv) ? argv : []).filter((item) => !String(item).startsWith('-'));
  if (!files.length) return JSON.stringify({ error: 'path is required.' });
  const chunks = [];
  for (const file of files) {
    const full = resolveReadPath(cwd, file);
    if (!existsSync(full)) return JSON.stringify({ error: `File not found: ${file}` });
    if (lstatSync(full).isDirectory()) return JSON.stringify({ error: `Is a directory: ${file}` });
    chunks.push(readFileSync(full, 'utf8'));
  }
  return limitTextOutput(chunks.join('\n'));
}

function executeNativeCat(ctx, args) {
  return readFiles(resolveReadCwd(ctx, args), args?.argv);
}

function parseFindArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  const paths = [];
  const opts = { maxDepth: Infinity, type: '', name: '' };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '-maxdepth' && args[index + 1] != null) {
      opts.maxDepth = Math.max(0, parseInt(args[index + 1], 10) || 0);
      index += 1;
    } else if (item === '-type' && args[index + 1] != null) {
      opts.type = String(args[index + 1] || '');
      index += 1;
    } else if (item === '-name' && args[index + 1] != null) {
      opts.name = String(args[index + 1] || '');
      index += 1;
    } else if (item === '-print') {
      continue;
    } else if (!item.startsWith('-')) {
      paths.push(item);
    }
  }
  return { paths: paths.length ? paths : ['.'], opts };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function findMatches(path, stat, opts) {
  if (opts.type === 'f' && !stat.isFile()) return false;
  if (opts.type === 'd' && !stat.isDirectory()) return false;
  if (opts.name) return globToRegExp(opts.name).test(basename(path));
  return true;
}

function walkFind(root, opts, depth, out) {
  const stat = lstatSync(root);
  if (findMatches(root, stat, opts)) out.push(root);
  if (!stat.isDirectory() || depth >= opts.maxDepth) return;
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    walkFind(join(root, entry.name), opts, depth + 1, out);
  }
}

function executeNativeFind(ctx, args) {
  const cwd = resolveReadCwd(ctx, args);
  const { paths, opts } = parseFindArgs(args?.argv);
  const out = [];
  for (const pathArg of paths) {
    const full = resolveReadPath(cwd, pathArg);
    if (!existsSync(full)) return JSON.stringify({ error: `Path not found: ${pathArg}` });
    walkFind(full, opts, 0, out);
  }
  return limitTextOutput(out.join('\n'));
}

function directorySize(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += directorySize(join(path, entry.name));
  }
  return total;
}

function parseDuArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((item) => String(item)) : [];
  const opts = { human: false, summary: false, depth: null, paths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '-d' && args[index + 1] != null) {
      opts.depth = Math.max(0, parseInt(args[index + 1], 10) || 0);
      index += 1;
    } else if (item.startsWith('--max-depth=')) {
      opts.depth = Math.max(0, parseInt(item.slice('--max-depth='.length), 10) || 0);
    } else if (item.startsWith('-')) {
      opts.human = opts.human || item.includes('h');
      opts.summary = opts.summary || item.includes('s');
    } else {
      opts.paths.push(item);
    }
  }
  if (!opts.paths.length) opts.paths.push('.');
  return opts;
}

function collectDu(path, depth, maxDepth, out) {
  const stat = lstatSync(path);
  if (stat.isDirectory() && depth < maxDepth) {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      collectDu(join(path, entry.name), depth + 1, maxDepth, out);
    }
  }
  out.push({ path, size: directorySize(path) });
}

function executeNativeDu(ctx, args) {
  const cwd = resolveReadCwd(ctx, args);
  const opts = parseDuArgs(args?.argv);
  const out = [];
  for (const pathArg of opts.paths) {
    const full = resolveReadPath(cwd, pathArg);
    if (!existsSync(full)) return JSON.stringify({ error: `Path not found: ${pathArg}` });
    if (opts.summary || opts.depth == null) {
      out.push({ path: full, size: directorySize(full) });
    } else {
      collectDu(full, 0, opts.depth, out);
    }
  }
  return limitTextOutput(out.map((entry) => `${formatBytes(entry.size, opts.human)}\t${entry.path}`).join('\n'));
}

function executeNativeFilesystem(ctx, args) {
  const action = String(args?.action || args?.command || '').trim().toLowerCase();
  if (!ALLOWED.has(action)) {
    return JSON.stringify({ error: `Command not allowed: ${action}. Allowed: ${[...ALLOWED].sort().join(', ')}.` });
  }
  try {
    if (action === 'ls') return executeNativeLs(ctx, args);
    if (action === 'pwd') return executeNativePwd(ctx, args);
    if (action === 'cd') return executeNativeCd(ctx, args);
    if (action === 'cat' || action === 'less') return executeNativeCat(ctx, args);
    if (action === 'find') return executeNativeFind(ctx, args);
    if (action === 'du') return executeNativeDu(ctx, args);
  } catch (err) {
    return JSON.stringify({ error: err.message || String(err) });
  }
  return JSON.stringify({ error: `Command not implemented: ${action}` });
}

function executeNpm(ctx, args) {
  const cwd = resolveReadCwd(ctx, args);
  const argv = Array.isArray(args?.argv) ? args.argv.map((item) => String(item)) : [];
  if (!argv.length) {
    return JSON.stringify({ error: 'npm requires at least one argument, such as install, test, run, or --version' });
  }

  return new Promise((resolveResult) => {
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const cmdArgs = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm', ...argv]
      : argv;
    let child;
    try {
      child = spawn(cmd, cmdArgs, { cwd });
    } catch (err) {
      resolveResult(JSON.stringify({ error: err.message || String(err) }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      finish(JSON.stringify({ error: `npm command timed out after ${Math.round(NPM_TIMEOUT_MS / 1000)}s.` }));
    }, NPM_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_TEXT_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_TEXT_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      finish(JSON.stringify({ error: err.message || String(err) }));
    });

    child.on('close', (code) => {
      const out = limitTextOutput(stdout);
      const err = limitTextOutput(stderr);
      if (code === 0) {
        finish(out || err || 'OK');
        return;
      }
      finish(JSON.stringify({ error: err || out || `npm exited with code ${code}`, stdout: out || undefined, stderr: err || undefined }));
    });
  });
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
  if (action === 'npm') {
    return executeNpm(ctx, args);
  }
  return executeNativeFilesystem(ctx, args);
}
