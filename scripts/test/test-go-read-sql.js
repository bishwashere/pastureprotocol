#!/usr/bin/env node
/**
 * Unit test for go-read action=sql.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGoRead } from '../../lib/agent/executors/go-read.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createIndex(stateDir) {
  const memoryDir = join(stateDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  const indexPath = join(memoryDir, 'index.db');
  const db = new Database(indexPath);
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      type TEXT
    );
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory'
    );
  `);
  const insertChunk = db.prepare('INSERT INTO chunks (path, text, source, type) VALUES (?, ?, ?, ?)');
  insertChunk.run('chat-log/private/owner.jsonl', 'hello', 'chat', 'chat');
  insertChunk.run('chat-log/private/owner.jsonl', 'brain count', 'chat', 'chat');
  insertChunk.run('MEMORY.md', 'likes concise answers', 'memory', 'preference');
  db.prepare('INSERT INTO files (path, source) VALUES (?, ?)').run('MEMORY.md', 'memory');
  db.close();
  return indexPath;
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-read-sql-'));
  const indexPath = createIndex(stateDir);
  process.env.PASTURE_STATE_DIR = stateDir;

  const count = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    sql: 'select count(*) as chunks from chunks',
  }));
  assert(count.path === indexPath, `expected default path ${indexPath}, got ${count.path}`);
  assert(count.rowCount === 1, `expected one count row, got ${count.rowCount}`);
  assert(count.rows[0].chunks === 3, `expected 3 chunks, got ${count.rows[0].chunks}`);

  const grouped = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: 'select source, count(*) as count from chunks group by source order by count desc',
  }));
  assert(grouped.rows.find((row) => row.source === 'chat')?.count === 2, 'expected chat source count');
  assert(grouped.rows.find((row) => row.source === 'memory')?.count === 1, 'expected memory source count');

  const schema = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: "select name from sqlite_master where type = ? order by name",
    params: ['table'],
  }));
  assert(schema.rows.some((row) => row.name === 'chunks'), 'expected chunks table in schema result');

  const blocked = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: "insert into chunks (path, text) values ('x', 'y')",
  }));
  assert(/read-only/i.test(blocked.error || ''), `expected read-only rejection, got ${JSON.stringify(blocked)}`);

  console.log('Go-read SQL test passed.');
  console.log(JSON.stringify({ chunks: count.rows[0].chunks, tables: schema.rows.map((row) => row.name) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
