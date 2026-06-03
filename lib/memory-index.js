/**
 * Memory index: SQLite + sqlite-vec for semantic search over MEMORY.md, optional memory/*.md notes,
 * and chat history (chat-log/*.jsonl). Daily conversation history is indexed from chat-log only.
 * Chat is auto-indexed on every exchange; no manual sync needed.
 */

import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { join, relative, dirname } from 'path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { embed, embedWithRetry } from './embeddings.js';
import { appendExchange } from './chat-log.js';

function toBuffer(arr) {
  const vec = new Float32Array(arr);
  return Buffer.from(vec.buffer);
}

const VECTOR_TABLE = 'chunks_vec';
const CHUNKS_TABLE = 'chunks';
const FILES_TABLE = 'files';
const SNIPPET_MAX_CHARS = 700;
const CHUNK_CHARS = 600;
const CHUNK_OVERLAP_CHARS = 80;
/** Legacy daily cron logs — not indexed; daily history is in chat-log/*.jsonl. */
const DATE_MEMORY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

let dbCache = null;
let vecLoaded = false;

/**
 * Ensure directory exists.
 * @param {string} dir
 */
function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Chunk markdown text into segments with line ranges. Uses fixed char size + overlap.
 * @param {string} fullText
 * @param {string} path - Relative path for the file
 * @returns {{ path: string, startLine: number, endLine: number, text: string }[]}
 */
export function chunkMarkdown(fullText, path) {
  const lines = fullText.split('\n');
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let charCount = 0;
    while (end < lines.length && (charCount < CHUNK_CHARS || end === start)) {
      charCount += (lines[end] || '').length + 1;
      end++;
    }
    const segment = lines.slice(start, end).join('\n');
    if (segment.trim()) {
      chunks.push({
        path,
        startLine: start + 1,
        endLine: end,
        text: segment,
      });
    }
    start = Math.max(start + 1, end - Math.floor(CHUNK_OVERLAP_CHARS / 20));
  }
  return chunks;
}

/**
 * List note files to index: MEMORY.md and optional non-dated memory/*.md (e.g. preferences.md).
 * Date-stamped memory/YYYY-MM-DD.md files are excluded — daily history lives in chat-log/*.jsonl.
 * @param {string} workspaceDir
 * @returns {{ relPath: string, mtimeMs: number }[]}
 */
export function listMemoryFiles(workspaceDir) {
  const out = [];
  try {
    const memoryMd = join(workspaceDir, 'MEMORY.md');
    if (existsSync(memoryMd)) {
      const stat = statSync(memoryMd);
      if (stat.isFile()) out.push({ relPath: 'MEMORY.md', mtimeMs: stat.mtimeMs });
    }
    const memoryAlt = join(workspaceDir, 'memory.md');
    if (existsSync(memoryAlt)) {
      const stat = statSync(memoryAlt);
      if (stat.isFile()) out.push({ relPath: 'memory.md', mtimeMs: stat.mtimeMs });
    }
    const memoryDir = join(workspaceDir, 'memory');
    if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
      const names = readdirSync(memoryDir);
      for (const name of names) {
        if (!name.endsWith('.md')) continue;
        if (DATE_MEMORY_FILE_RE.test(name)) continue;
        const full = join(memoryDir, name);
        try {
          const stat = statSync(full);
          if (stat.isFile()) out.push({ relPath: `memory/${name}`, mtimeMs: stat.mtimeMs });
        } catch (_) {}
      }
    }
  } catch (_) {}
  return out;
}

/**
 * List chat-log JSONL files (workspace/chat-log/YYYY-MM-DD.jsonl and chat-log/private/*.jsonl).
 * @param {string} workspaceDir
 * @returns {{ relPath: string, mtimeMs: number }[]}
 */
export function listChatLogFiles(workspaceDir) {
  const out = [];
  const chatLogDir = join(workspaceDir, 'chat-log');
  try {
    if (!existsSync(chatLogDir) || !statSync(chatLogDir).isDirectory()) return out;
    const names = readdirSync(chatLogDir);
    for (const name of names) {
      if (name.endsWith('.jsonl')) {
        const full = join(chatLogDir, name);
        try {
          const stat = statSync(full);
          if (stat.isFile()) out.push({ relPath: `chat-log/${name}`, mtimeMs: stat.mtimeMs });
        } catch (_) {}
      } else if (name === 'private') {
        const privateDir = join(chatLogDir, name);
        try {
          if (!statSync(privateDir).isDirectory()) continue;
          const subNames = readdirSync(privateDir);
          for (const sub of subNames) {
            if (!sub.endsWith('.jsonl')) continue;
            const full = join(privateDir, sub);
            const stat = statSync(full);
            if (stat.isFile()) out.push({ relPath: `chat-log/private/${sub}`, mtimeMs: stat.mtimeMs });
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return out;
}

/** Match YYYY-MM-DD in path (e.g. chat-log/2025-02-20.jsonl). */
const DATE_IN_PATH = /(\d{4}-\d{2}-\d{2})/;
/** Match note date prefix in first line: "- 2025-02-15: ..." */
const DATE_IN_NOTE_LINE = /^\s*-\s*(\d{4}-\d{2}-\d{2})[\s:]/m;
/** Match typed note prefix: "- 2025-02-15 [type]: ..." */
const TYPE_IN_NOTE_LINE = /^\s*-\s*\d{4}-\d{2}-\d{2}\s*\[([^\]]+)\]/m;

/**
 * Infer chunk_date for a chunk: from path (chat-log/YYYY-MM-DD.jsonl) or from note line in MEMORY.md text.
 * @param {string} path - Relative path
 * @param {string} chunkText - Chunk text (for MEMORY.md we look for "- YYYY-MM-DD:" in first line)
 * @returns {string | null} YYYY-MM-DD or null
 */
function inferChunkDate(path, chunkText) {
  const fromPath = path.match(DATE_IN_PATH);
  if (fromPath) return fromPath[1];
  const fromText = (chunkText || '').match(DATE_IN_NOTE_LINE);
  if (fromText) return fromText[1];
  return null;
}

/**
 * Infer type from note line prefix: "- YYYY-MM-DD [type]: ..."
 * @param {string} path - Relative path
 * @param {string} chunkText
 * @returns {string | null}
 */
function inferChunkType(path, chunkText) {
  if (path.startsWith('chat-log/')) return 'chat';
  if (path.startsWith('filesystem/')) return 'filesystem';
  const fromText = (chunkText || '').match(TYPE_IN_NOTE_LINE);
  if (fromText) return fromText[1].trim().toLowerCase();
  return null;
}

/**
 * Chunk a chat-log JSONL file into one chunk per line (User/Assistant exchange).
 * @param {string} content - Raw file content
 * @param {string} path - Relative path e.g. chat-log/2025-02-20.jsonl
 * @returns {{ path: string, startLine: number, endLine: number, text: string }[]}
 */
function chunkChatLog(content, path) {
  const lines = content.split('\n').filter((l) => l.trim());
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]);
      const user = (row.user != null ? String(row.user) : '').trim();
      const assistant = (row.assistant != null ? String(row.assistant) : '').trim();
      const text = `User: ${user}\nAssistant: ${assistant}`.trim();
      if (text) chunks.push({ path, startLine: i + 1, endLine: i + 1, text });
    } catch (_) {}
  }
  return chunks;
}

/**
 * Open database and ensure schema. Load sqlite-vec.
 * @param {string} indexPath
 * @param {number} dimensions - Vector dimension (set after first embed)
 * @returns {import('better-sqlite3').Database}
 */
function openDb(indexPath, dimensions = 0) {
  ensureDir(join(indexPath, '..'));
  const db = new Database(indexPath);
  if (typeof db.defaultSafeIntegers === 'function') db.defaultSafeIntegers(false);
  sqliteVec.load(db);
  if (!vecLoaded) vecLoaded = true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FILES_TABLE} (
      path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory'
    );
    CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      chunk_date TEXT,
      type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON ${CHUNKS_TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_chunk_date ON ${CHUNKS_TABLE}(chunk_date);
  `);
  try {
    db.exec(`ALTER TABLE ${CHUNKS_TABLE} ADD COLUMN chunk_date TEXT`);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (!msg.includes('duplicate column name')) throw e;
  }
  try {
    db.exec(`ALTER TABLE ${CHUNKS_TABLE} ADD COLUMN type TEXT`);
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (!msg.includes('duplicate column name')) throw e;
  }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_type ON ${CHUNKS_TABLE}(type)`);
  } catch (_) {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_chunk_date ON ${CHUNKS_TABLE}(chunk_date)`);
  } catch (_) {}
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON ${CHUNKS_TABLE}(source)`);
  } catch (_) {}
  if (dimensions > 0) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${dimensions}]);`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (!msg.includes('already exists')) throw e;
    }
  }
  return db;
}

/**
 * Get or create cached DB for this indexPath. Creates vector table when dimensions known.
 * @param {string} indexPath
 * @param {number} [dimensions]
 */
function getDb(indexPath, dimensions = 0) {
  if (!dbCache || dbCache.path !== indexPath) {
    if (dbCache) {
      try { dbCache.db.close(); } catch (_) {}
    }
    dbCache = { path: indexPath, db: openDb(indexPath, dimensions), dimensions: dimensions || null };
    return dbCache.db;
  }
  if (dimensions > 0 && dbCache.dimensions !== dimensions) {
    try { dbCache.db.close(); } catch (_) {}
    dbCache.db = openDb(indexPath, dimensions);
    dbCache.dimensions = dimensions;
  }
  return dbCache.db;
}

/**
 * If the vec table has BigInt primary keys (legacy), repair it once. Call early in sync so DELETEs don't throw.
 * @param {import('better-sqlite3').Database} db
 * @param {{ baseUrl: string, apiKey: string, model: string }} embeddingConfig
 */
async function repairVecTableIfNeeded(db, embeddingConfig) {
  const probe = db.prepare(`SELECT id FROM ${CHUNKS_TABLE} LIMIT 1`).get();
  if (!probe) return;
  try {
    db.prepare(`SELECT chunk_id FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).get(Number(probe.id));
    return;
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (msg.includes('no such table') || msg.includes('no such module')) return;
    if (!isIntegerPkError(msg)) throw e;
  }
  const row = db.prepare(`SELECT id, text FROM ${CHUNKS_TABLE} LIMIT 1`).get();
  if (!row) {
    try { db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`); } catch (_) {}
    return;
  }
  const [vec] = await embed([row.text || ''], embeddingConfig);
  if (!vec || vec.length === 0) return;
  console.log('[memory] Rebuilding vec table (integer primary key fix).');
  await rebuildVecTable(db, vec.length, embeddingConfig);
}

/**
 * Backfill chunk_date and type for existing chunks that have NULL (e.g. after upgrade).
 * So "what did I note last week?" works for users who updated without re-indexing.
 * @param {import('better-sqlite3').Database} db
 */
function backfillChunkDates(db) {
  let rows;
  try {
    rows = db.prepare(`SELECT id, path, text FROM ${CHUNKS_TABLE} WHERE chunk_date IS NULL OR type IS NULL`).all();
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    if (msg.includes('no such column')) return;
    throw e;
  }
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE ${CHUNKS_TABLE} SET chunk_date = COALESCE(chunk_date, ?), type = COALESCE(type, ?) WHERE id = ?`);
  for (const row of rows) {
    const d = inferChunkDate(row.path, row.text);
    const t = inferChunkType(row.path, row.text);
    if (d || t) update.run(d, t, row.id);
  }
}

/**
 * Sync workspace to index: MEMORY.md (+ optional memory/*.md notes) and chat-log/*.jsonl.
 * Daily conversation history is indexed from chat-log only; date-stamped memory/*.md files are ignored.
 * @param {{ workspaceDir: string, indexPath: string, embedding: { baseUrl: string, apiKey: string, model: string }, chunking: { tokens: number, overlap: number } }} config
 * @param {{ onFile?: (relPath: string) => void, maxFiles?: number }} [options] - Optional progress callback and max files (for testing with --limit).
 */
export async function sync(config, options = {}) {
  const { workspaceDir, indexPath, embedding, chunking } = config;
  const { onFile } = options;
  const memoryFiles = listMemoryFiles(workspaceDir);
  const chatLogFiles = listChatLogFiles(workspaceDir);
  const files = [...memoryFiles, ...chatLogFiles];

  const db = getDb(indexPath);
  await repairVecTableIfNeeded(db, embedding);
  backfillChunkDates(db);
  if (files.length === 0) return;
  const existingFiles = new Map();
  try {
    const rows = db.prepare(`SELECT path, mtime_ms FROM ${FILES_TABLE}`).all();
    for (const r of rows) existingFiles.set(r.path, r.mtime_ms);
  } catch (_) {}

  const toProcess = [];
  for (const { relPath, mtimeMs } of files) {
    const prev = existingFiles.get(relPath);
    if (prev === mtimeMs) continue;
    toProcess.push({ relPath, mtimeMs });
  }
  const toProcessLimited =
    options.maxFiles != null
      ? toProcess.slice(0, Math.max(1, Math.floor(Number(options.maxFiles)) || 1))
      : toProcess;

  const toDelete = [];
  for (const path of existingFiles.keys()) {
    if (path.startsWith('filesystem/')) continue;
    if (!files.some((f) => f.relPath === path)) toDelete.push(path);
  }

  for (const path of toDelete) {
    const ids = db.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE path = ?`).all(path).map((r) => r.id);
    for (const id of ids) {
      try { db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(id)); } catch (_) {}
    }
    db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE path = ?`).run(path);
    db.prepare(`DELETE FROM ${FILES_TABLE} WHERE path = ?`).run(path);
  }

  for (const { relPath, mtimeMs } of toProcessLimited) {
    if (onFile) onFile(relPath);
    const fullPath = join(workspaceDir, relPath);
    let content = '';
    try {
      content = readFileSync(fullPath, 'utf8');
    } catch (_) {
      continue;
    }
    const isChatLog = relPath.startsWith('chat-log/') && relPath.endsWith('.jsonl');
    const chunks = isChatLog ? chunkChatLog(content, relPath) : chunkMarkdown(content, relPath);
    const source = isChatLog ? 'chat' : 'memory';
    if (chunks.length === 0) {
      db.prepare(`INSERT OR REPLACE INTO ${FILES_TABLE} (path, mtime_ms, source) VALUES (?, ?, ?)`).run(relPath, mtimeMs, source);
      continue;
    }

    const texts = chunks.map((c) => c.text);
    let vectors;
    try {
      vectors = await embedWithRetry(texts, embedding);
    } catch (err) {
      console.log('[memory] Couldn\'t index (embedding service not available).');
      console.error('[memory] Embedding error:', err.message);
      throw err;
    }
    if (vectors.length !== chunks.length) throw new Error('Embed count mismatch');

    const dims = vectors[0].length;
    const dbWithVec = getDb(indexPath, dims);
    dbWithVec.exec('BEGIN');
    try {
      const existingIds = dbWithVec.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE path = ?`).all(relPath).map((r) => r.id);
      for (const id of existingIds) {
        try {
          dbWithVec.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(id));
        } catch (e) {
          const em = (e && e.message) ? e.message : String(e);
          if (isIntegerPkError(em)) {
            dbWithVec.exec('ROLLBACK');
            console.log('[memory] Rebuilding vec table (integer primary key fix).');
            await rebuildVecTable(dbWithVec, dims, embedding);
            dbWithVec.exec('BEGIN');
            for (const id2 of existingIds) {
              try { dbWithVec.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(id2)); } catch (_) {}
            }
            break;
          }
          throw e;
        }
      }
      dbWithVec.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE path = ?`).run(relPath);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        const chunkDate = inferChunkDate(relPath, c.text);
        const chunkType = inferChunkType(relPath, c.text);
        const ins = dbWithVec.prepare(
          `INSERT INTO ${CHUNKS_TABLE} (path, start_line, end_line, text, source, chunk_date, type) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(relPath, c.startLine, c.endLine, c.text, source, chunkDate, c.type ?? chunkType ?? null);
        const chunkId = Number(ins.lastInsertRowid);
        dbWithVec.prepare(`INSERT INTO ${VECTOR_TABLE} (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(chunkId, toBuffer(vectors[i]));
      }
      dbWithVec.prepare(`INSERT OR REPLACE INTO ${FILES_TABLE} (path, mtime_ms, source) VALUES (?, ?, ?)`).run(relPath, mtimeMs, source);
      dbWithVec.exec('COMMIT');
    } catch (e) {
      dbWithVec.exec('ROLLBACK');
      throw e;
    }
  }
}

const FILESYSTEM_SOURCE = 'filesystem';
/** Skip dependency/build/generated dirs so we don't create hundreds of useless chunks in code repos. */
const DEFAULT_FILESYSTEM_EXCLUDE_DIRS = [
  '.git', 'node_modules', '.pasture', '__pycache__', '.venv', 'venv', '.next', '.cache', '.tox', 'dist', 'build',
  'Pods', '.dart_tool', 'target', 'vendor', 'bower_components', '.gradle', '.idea', '.vscode',
];
/** Max chunks per embedding API request. Only when a batch hits context-length error do we retry with half; next batch is unchanged. */
const FILESYSTEM_EMBED_BATCH_SIZE = 100;

/**
 * Walk a directory and collect one chunk per directory: "Directory: <path>\nContents: item1, item2, ...".
 * @param {string} rootDir - Absolute path to root
 * @param {{ maxDepth: number, excludeDirs: string[], onDir?: (dirPath: string) => void, maxChunks?: number }} opts
 * @param {string} [relPrefix] - Relative path prefix for path stored in index
 * @returns {{ path: string, text: string }[]}
 */
function walkFilesystemChunks(rootDir, opts, relPrefix = '') {
  const { maxDepth, excludeDirs, onDir, maxChunks } = opts;
  const chunks = [];
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return chunks;

  function walk(dir, depth, relPath) {
    if (maxChunks != null && chunks.length >= maxChunks) return;
    if (depth > maxDepth) return;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (_) {
      return;
    }
    const items = [];
    const subdirs = [];
    for (const name of names) {
      if (name.startsWith('.') && name !== '.') continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        if (excludeDirs.includes(name)) continue;
        if (name === 'verify' && depth === 1) continue;
        subdirs.push(name + '/');
      } else {
        items.push(name);
      }
    }
    items.sort();
    subdirs.sort();
    const list = [...subdirs, ...items];
    const text = `Directory: ${dir}\nContents: ${list.join(', ') || '(empty)'}`.trim();
    const pathKey = relPath ? `filesystem/${relPath}` : 'filesystem/';
    chunks.push({ path: pathKey, text });
    if (onDir) onDir(dir);
    if (maxChunks != null && chunks.length >= maxChunks) return;

    for (const sub of subdirs) {
      const subName = sub.slice(0, -1);
      walk(join(dir, subName), depth + 1, relPath ? `${relPath}/${subName}` : subName);
    }
  }

  walk(rootDir, 1, relPrefix);
  return chunks;
}

/**
 * Walk directory tree and yield chunk arrays of size batchSize (last yield may be smaller).
 * Yields each batch as soon as it is full so the caller can embed immediately.
 * @param {string} rootDir - Absolute path to root
 * @param {{ maxDepth: number, excludeDirs: string[], onDir?: (dirPath: string) => void, maxChunks?: number }} opts
 * @param {number} batchSize
 * @param {string} [relPrefix]
 * @returns {Generator<{ path: string, text: string }[]>}
 */
function* walkFilesystemChunksBatched(rootDir, opts, batchSize, relPrefix = '') {
  const { maxDepth, excludeDirs, onDir, maxChunks } = opts;
  const batch = [];
  let totalChunks = 0;
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) return;

  function* walk(dir, depth, relPath) {
    if (maxChunks != null && totalChunks >= maxChunks) return;
    if (depth > maxDepth) return;
    let names = [];
    try {
      names = readdirSync(dir);
    } catch (_) {
      return;
    }
    const items = [];
    const subdirs = [];
    for (const name of names) {
      if (name.startsWith('.') && name !== '.') continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        if (excludeDirs.includes(name)) continue;
        if (name === 'verify' && depth === 1) continue;
        subdirs.push(name + '/');
      } else {
        items.push(name);
      }
    }
    items.sort();
    subdirs.sort();
    const list = [...subdirs, ...items];
    const text = `Directory: ${dir}\nContents: ${list.join(', ') || '(empty)'}`.trim();
    const pathKey = relPath ? `filesystem/${relPath}` : 'filesystem/';
    batch.push({ path: pathKey, text });
    totalChunks++;
    if (onDir) onDir(dir);
    if (batch.length >= batchSize) {
      yield batch.splice(0, batchSize);
    }
    if (maxChunks != null && totalChunks >= maxChunks) return;
    for (const sub of subdirs) {
      const subName = sub.slice(0, -1);
      yield* walk(join(dir, subName), depth + 1, relPath ? `${relPath}/${subName}` : subName);
    }
  }

  yield* walk(rootDir, 1, relPrefix);
  if (batch.length > 0) yield batch;
}

/**
 * Index a directory tree into the memory index with source='filesystem'.
 * Use for "pasture index --source filesystem" so the agent can answer "what files do I have?", "where is X?".
 * Resumable: progress is saved after each batch; on re-run with same root we skip already-indexed batches and continue.
 * When root changes or no progress file, does a full reindex (removes existing filesystem chunks first).
 * @param {{ workspaceDir: string, indexPath: string, embedding: { baseUrl: string, apiKey: string, model: string } }} config
 * @param {{ root?: string, maxDepth?: number, maxChunks?: number, excludeDirs?: string[], onDir?: (dirPath: string) => void, embedBatchSize?: number }} [options]
 */
export async function indexFilesystem(config, options = {}) {
  const root = (options.root && String(options.root).trim()) || config.workspaceDir;
  const maxDepth = Math.max(1, Math.min(20, Number(options.maxDepth) || 8));
  const maxChunks = options.maxChunks != null ? Math.max(1, Math.floor(Number(options.maxChunks)) || 1) : undefined;
  const excludeDirs = Array.isArray(options.excludeDirs) ? options.excludeDirs : DEFAULT_FILESYSTEM_EXCLUDE_DIRS;
  const onDir = options.onDir || null;
  const resolvedRoot = root.startsWith('/') ? root : join(config.workspaceDir, root);
  const relPrefix = relative(config.workspaceDir, resolvedRoot).replace(/^\.\.\/?/, '') || '';

  const progressPath = join(dirname(config.indexPath), 'index-filesystem-progress.json');
  let progress = null;
  try {
    const raw = readFileSync(progressPath, 'utf8');
    progress = JSON.parse(raw);
  } catch (_) {}

  const isResume = progress && progress.root === resolvedRoot && Number(progress.batchNum) >= 0;
  const skipUntilBatch = isResume ? Number(progress.batchNum) : null;

  const batchSize = Math.max(1, Math.min(1000, Number(options.embedBatchSize) || FILESYSTEM_EMBED_BATCH_SIZE));
  const walkOpts = { maxDepth, excludeDirs, onDir, maxChunks };

  const db = getDb(config.indexPath);
  await repairVecTableIfNeeded(db, config.embedding);

  if (!isResume) {
    const ids = db.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE source = ?`).all(FILESYSTEM_SOURCE).map((r) => r.id);
    for (const id of ids) {
      try {
        db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(id));
      } catch (_) {}
    }
    db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE source = ?`).run(FILESYSTEM_SOURCE);
    db.prepare(`DELETE FROM ${FILES_TABLE} WHERE path LIKE ?`).run('filesystem/%');
    if (progress) try { unlinkSync(progressPath); } catch (_) {}
  } else {
    console.log('[index] Resuming from batch', skipUntilBatch + 1, '...');
  }

  let dims = null;
  let dbWithVec = null;
  let insertChunk = null;
  let insertVec = null;
  let insertFile = null;
  let totalChunks = 0;
  let batchNum = 0;
  const seenPaths = new Set();

  for (const batch of walkFilesystemChunksBatched(resolvedRoot, walkOpts, batchSize, relPrefix)) {
    if (batch.length === 0) continue;
    batchNum++;
    for (const c of batch) seenPaths.add(c.path);

    if (skipUntilBatch != null && batchNum <= skipUntilBatch) {
      totalChunks += batch.length;
      continue;
    }

    totalChunks += batch.length;
    const batchTexts = batch.map((c) => c.text);

    console.log('[index] Embedding batch', batchNum, '(' + batch.length, 'chunks)...');
    let vectors;
    try {
      vectors = await embedWithRetry(batchTexts, config.embedding);
    } catch (err) {
      console.error('[index] Embedding failed:', err && err.message ? err.message : err);
      writeFileSync(progressPath, JSON.stringify({ root: resolvedRoot, batchNum: batchNum - 1, totalChunks }, null, 0), 'utf8');
      throw err;
    }
    if (vectors.length !== batch.length) throw new Error('Embed count mismatch');

    if (dims == null) {
      dims = vectors[0].length;
      dbWithVec = getDb(config.indexPath, dims);
      try {
        dbWithVec.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${dims}]);`);
      } catch (_) {}
      insertChunk = dbWithVec.prepare(
        `INSERT INTO ${CHUNKS_TABLE} (path, start_line, end_line, text, source, chunk_date, type) VALUES (?, 1, 1, ?, ?, NULL, 'filesystem')`
      );
      insertVec = dbWithVec.prepare(`INSERT INTO ${VECTOR_TABLE} (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)`);
      insertFile = dbWithVec.prepare(`INSERT OR REPLACE INTO ${FILES_TABLE} (path, mtime_ms, source) VALUES (?, ?, ?)`);
    }

    for (let i = 0; i < batch.length; i++) {
      const c = batch[i];
      const ins = insertChunk.run(c.path, c.text, FILESYSTEM_SOURCE);
      const chunkId = Number(ins.lastInsertRowid);
      insertVec.run(chunkId, toBuffer(vectors[i]));
      insertFile.run(c.path, Date.now(), FILESYSTEM_SOURCE);
    }

    try {
      writeFileSync(progressPath, JSON.stringify({ root: resolvedRoot, batchNum, totalChunks }, null, 0), 'utf8');
    } catch (_) {}
  }

  const dbFinal = dims != null ? getDb(config.indexPath, dims) : db;
  if (seenPaths.size > 0) {
    const toRemove = dbFinal.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE source = ? AND path NOT IN (${[...seenPaths].map(() => '?').join(',')})`).all(FILESYSTEM_SOURCE, ...seenPaths);
    for (const row of toRemove) {
      try {
        dbFinal.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(row.id));
      } catch (_) {}
    }
    if (toRemove.length > 0) {
      dbFinal.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE id IN (${toRemove.map((r) => '?').join(',')})`).run(...toRemove.map((r) => r.id));
    }
    const placeholders = [...seenPaths].map(() => '?').join(',');
    dbFinal.prepare(`DELETE FROM ${FILES_TABLE} WHERE source = ? AND path LIKE 'filesystem/%' AND path NOT IN (${placeholders})`).run(FILESYSTEM_SOURCE, ...seenPaths);
  } else {
    const ids = dbFinal.prepare(`SELECT id FROM ${CHUNKS_TABLE} WHERE source = ?`).all(FILESYSTEM_SOURCE).map((r) => r.id);
    for (const id of ids) {
      try {
        dbFinal.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE chunk_id = ?`).run(Number(id));
      } catch (_) {}
    }
    dbFinal.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE source = ?`).run(FILESYSTEM_SOURCE);
    dbFinal.prepare(`DELETE FROM ${FILES_TABLE} WHERE path LIKE ?`).run('filesystem/%');
  }
  try {
    unlinkSync(progressPath);
  } catch (_) {}

  if (totalChunks === 0) {
    console.log('[index] No directory chunks under', resolvedRoot);
    return;
  }
  console.log('[index] Indexed', totalChunks, 'directory chunks from', resolvedRoot);
}

/**
 * Append exchange to chat log and embed + insert one chunk so "Remember what we said?" can pull from logs.
 * No manual sync: every message is auto-indexed.
 * @param {ReturnType<import('./memory-config.js').getMemoryConfig>} config
 * @param {{ user: string, assistant: string, timestampMs: number, jid?: string }} exchange
 */
export async function indexChatExchange(config, exchange) {
  if (!config) return null;
  const { workspaceDir, indexPath, embedding } = config;
  let path; let lineNumber;
  try {
    const out = appendExchange(workspaceDir, exchange);
    path = out.path;
    lineNumber = out.lineNumber;
  } catch (err) {
    console.log('[memory] Couldn\'t save chat log.');
    return null;
  }
  const text = `User: ${(exchange.user || '').trim()}\nAssistant: ${(exchange.assistant || '').trim()}`.trim();
  if (!text) return { path, lineNumber };
  let vectors;
  try {
    vectors = await embed([text], embedding);
  } catch (err) {
    console.log('[memory] Couldn\'t save chat to memory (embedding not available).');
    console.error('[memory] Embedding error:', err.message);
    return { path, lineNumber };
  }
  const vec = vectors[0];
  if (!vec || vec.length === 0) return { path, lineNumber };
  const db = getDb(indexPath, vec.length);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${vec.length}]);`);
  } catch (_) {}
  const chunkDate = path.match(DATE_IN_PATH) ? path.match(DATE_IN_PATH)[1] : null;
  const ins = db.prepare(
    `INSERT INTO ${CHUNKS_TABLE} (path, start_line, end_line, text, source, chunk_date, type) VALUES (?, ?, ?, ?, 'chat', ?, 'chat')`
  ).run(path, lineNumber, lineNumber, text, chunkDate);
  const chunkId = Number(ins.lastInsertRowid) || 1;
  db.prepare(`INSERT INTO ${VECTOR_TABLE} (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(chunkId, toBuffer(vec));
  return { path, lineNumber };
}

/**
 * Index one custom text chunk (e.g. retrospective bad-case).
 * @returns {Promise<{ path: string, lineNumber: number } | null>}
 */
export async function indexCustomChunk(config, { relPath, lineNumber, text, type = 'note', chunkDate = null }) {
  if (!config || !relPath || !text || !lineNumber) return null;
  const { workspaceDir, indexPath, embedding } = config;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  let vectors;
  try {
    vectors = await embed([trimmed], embedding);
  } catch (err) {
    console.error('[memory] Custom chunk embedding failed:', err.message);
    return null;
  }
  const vec = vectors[0];
  if (!vec || vec.length === 0) return null;
  const db = getDb(indexPath, vec.length);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${vec.length}]);`);
  } catch (_) {}
  const ins = db.prepare(
    `INSERT INTO ${CHUNKS_TABLE} (path, start_line, end_line, text, source, chunk_date, type) VALUES (?, ?, ?, ?, 'memory', ?, ?)`
  ).run(relPath, lineNumber, lineNumber, trimmed, chunkDate, type);
  const chunkId = Number(ins.lastInsertRowid) || 1;
  db.prepare(`INSERT INTO ${VECTOR_TABLE} (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(chunkId, toBuffer(vec));
  return { path: relPath, lineNumber };
}

function isIntegerPkError(msg) {
  return typeof msg === 'string' && msg.includes('primary key') && msg.includes('chunks_vec');
}

/**
 * One-time repair: rebuild chunks_vec with integer chunk_ids (fixes BigInt-written indexes).
 * @param {import('better-sqlite3').Database} db
 * @param {number} dimensions
 * @param {{ baseUrl: string, apiKey: string, model: string }} embeddingConfig
 */
async function rebuildVecTable(db, dimensions, embeddingConfig) {
  const rows = db.prepare(`SELECT id, text FROM ${CHUNKS_TABLE}`).all();
  try {
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
  } catch (_) {}
  db.exec(`CREATE VIRTUAL TABLE ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${dimensions}]);`);
  if (rows.length === 0) return;
  const texts = rows.map((r) => r.text || '');
  const vectors = await embedWithRetry(texts, embeddingConfig);
  if (vectors.length !== rows.length) return;
  const ins = db.prepare(`INSERT INTO ${VECTOR_TABLE} (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)`);
  for (let i = 0; i < rows.length; i++) {
    ins.run(Number(rows[i].id), toBuffer(vectors[i]));
  }
}

/**
 * Search by query embedding. Returns top snippets. Optional date range narrows to chunks with chunk_date in [dateFrom, dateTo].
 * @param {string} query
 * @param {{ workspaceDir: string, indexPath: string, embedding: object, search: { maxResults: number, minScore: number, dateFrom?: string, dateTo?: string } }} config
 * @returns {Promise<{ path: string, startLine: number, endLine: number, snippet: string, score: number }[]>}
 */
export async function search(query, config) {
  const { workspaceDir, indexPath, embedding, search: searchOpts } = config;
  const maxResults = searchOpts?.maxResults ?? 6;
  const minScore = searchOpts?.minScore ?? 0;
  const dateFrom = (searchOpts?.dateFrom && String(searchOpts.dateFrom).trim()) || null;
  const dateTo = (searchOpts?.dateTo && String(searchOpts.dateTo).trim()) || null;
  const typeFilter = (searchOpts?.type && String(searchOpts.type).trim()) || null;
  const hasDateFilter = dateFrom || dateTo;

  const [queryVec] = await embed([query.trim()], embedding);
  if (!queryVec || queryVec.length === 0) return [];

  const db = getDb(indexPath, queryVec.length);
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(chunk_id integer primary key, embedding float[${queryVec.length}]);`);
  } catch (_) {}

  const vecBlob = toBuffer(queryVec);
  const limit = (hasDateFilter || typeFilter) ? Math.min(100, Math.max(1, Math.floor(Number(maxResults)) || 1) * 5) : Math.max(1, Math.floor(Number(maxResults)) || 1);
  let rows;
  try {
    rows = db.prepare(
      `SELECT chunk_id, distance FROM ${VECTOR_TABLE} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    ).all(vecBlob, limit);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    if (isIntegerPkError(msg)) {
      console.log('[memory] Rebuilding vec table (integer primary key fix).');
      try {
        await rebuildVecTable(db, queryVec.length, embedding);
        rows = db.prepare(
          `SELECT chunk_id, distance FROM ${VECTOR_TABLE} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
        ).all(vecBlob, limit);
      } catch (rebuildErr) {
        console.error('[memory] Rebuild failed:', rebuildErr && rebuildErr.message ? rebuildErr.message : rebuildErr);
        throw err;
      }
    } else {
      throw err;
    }
  }

  const results = [];
  const maxReturn = Math.max(1, Math.floor(Number(maxResults)) || 1);
  for (const row of rows) {
    if (results.length >= maxReturn) break;
    let score = 1 - row.distance / 2;
    if (score < 0) score = 0;
    if (score < minScore) continue;
    const chunk = db.prepare(`SELECT path, start_line, end_line, text, chunk_date, type FROM ${CHUNKS_TABLE} WHERE id = ?`).get(Number(row.chunk_id));
    if (!chunk) continue;
    if (hasDateFilter && chunk.chunk_date != null) {
      if (dateFrom && chunk.chunk_date < dateFrom) continue;
      if (dateTo && chunk.chunk_date > dateTo) continue;
    }
    if (hasDateFilter && chunk.chunk_date == null) continue;
    if (typeFilter && chunk.type !== typeFilter) continue;
    const snippet = (chunk.text || '').slice(0, SNIPPET_MAX_CHARS) + ((chunk.text || '').length > SNIPPET_MAX_CHARS ? '…' : '');
    results.push({
      path: chunk.path,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      snippet,
      score,
      type: chunk.type ?? null,
    });
  }
  return results;
}

/** List filesystem chunks (path LIKE 'filesystem/%') without vector search. */
export function listFilesystemChunks(config, limit = 20) {
  const db = getDb(config.indexPath);
  const maxReturn = Math.max(1, Math.min(100, Math.floor(Number(limit)) || 20));
  const rows = db.prepare(
    `SELECT path, start_line, end_line, text FROM ${CHUNKS_TABLE} WHERE path LIKE 'filesystem/%' ORDER BY path LIMIT ?`
  ).all(maxReturn);
  return rows.map((chunk) => ({
    path: chunk.path,
    startLine: chunk.start_line,
    endLine: chunk.end_line,
    snippet: (chunk.text || '').slice(0, SNIPPET_MAX_CHARS) + ((chunk.text || '').length > SNIPPET_MAX_CHARS ? '…' : ''),
    score: 0.5,
  }));
}

/**
 * Read file under workspace by relative path. Optional line range.
 * Supports .md (MEMORY.md, memory/*.md) and chat-log/*.jsonl (formatted as "User: ...\nAssistant: ...").
 * @param {string} workspaceDir
 * @param {string} relPath
 * @param {number} [from] - 1-based start line
 * @param {number} [lines] - number of lines
 * @returns {{ text: string, path: string }}
 */
export function readFile(workspaceDir, relPath, from, lines) {
  const normalized = relPath.replace(/\\/g, '/').trim();
  if (!normalized || normalized.startsWith('..') || normalized.includes('/..') || normalized.startsWith('/')) {
    throw new Error('path must be relative to workspace (e.g. MEMORY.md or memory/2025-02-15.md or chat-log/2025-02-16.jsonl)');
  }
  const resolved = join(workspaceDir, normalized);
  const rel = relative(workspaceDir, resolved);
  if (rel.startsWith('..') || rel.includes('..')) throw new Error('path escapes workspace');

  if (normalized.startsWith('chat-log/') && normalized.endsWith('.jsonl')) {
    const content = readFileSync(resolved, 'utf8');
    const lineArr = content.split('\n').filter((l) => l.trim());
    const start = Math.max(0, (from ?? 1) - 1);
    const count = lines ?? lineArr.length;
    const slice = lineArr.slice(start, start + Math.max(1, count));
    const formatted = slice
      .map((line) => {
        try {
          const o = JSON.parse(line);
          return `User: ${(o.user || '').trim()}\nAssistant: ${(o.assistant || '').trim()}`;
        } catch (_) {
          return line;
        }
      })
      .join('\n\n');
    return { text: formatted, path: normalized };
  }

  if (!normalized.endsWith('.md')) throw new Error('Only .md or chat-log/*.jsonl under workspace are allowed');
  const content = readFileSync(resolved, 'utf8');
  if (from == null && lines == null) return { text: content, path: normalized };
  const lineArr = content.split('\n');
  const start = Math.max(1, (from ?? 1)) - 1;
  const count = Math.max(1, (lines ?? lineArr.length));
  const slice = lineArr.slice(start, start + count).join('\n');
  return { text: slice, path: normalized };
}

/**
 * Get memory index interface: sync, search, readFile. Lazy init of DB on first sync/search.
 * @param {ReturnType<import('./memory-config.js').getMemoryConfig>} config - From getMemoryConfig()
 * @returns {{ sync: ()=>Promise<void>, search: (q:string, opts?:{ dateFrom?: string, dateTo?: string })=>Promise<object[]>, readFile: (path:string, from?:number, lines?:number)=>object } | null}
 */
export function getMemoryIndex(config) {
  if (!config) return null;
  return {
    async sync() {
      await sync(config);
    },
    async search(query, opts = {}) {
      await sync(config);
      const searchConfig = (opts.dateFrom != null || opts.dateTo != null || opts.maxResults != null || opts.type != null)
        ? { ...config, search: { ...config.search, dateFrom: opts.dateFrom ?? undefined, dateTo: opts.dateTo ?? undefined, maxResults: opts.maxResults ?? config.search.maxResults, type: opts.type ?? undefined } }
        : config;
      return search(query, searchConfig);
    },
    readFile(relPath, from, lines) {
      return readFile(config.workspaceDir, relPath, from, lines);
    },
    listFilesystem(limit = 20) {
      return listFilesystemChunks(config, limit);
    },
  };
}
