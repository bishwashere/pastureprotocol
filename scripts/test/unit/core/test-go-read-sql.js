#!/usr/bin/env node
/**
 * Unit test for go-read action=sql.
 */

import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGoRead } from '../../../../lib/agent/executors/go-read.js';

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
    action: 'sql_schema',
    path: indexPath,
    sampleRows: 1,
  }));
  const chunksTable = schema.tables.find((table) => table.name === 'chunks');
  assert(chunksTable, 'expected chunks table in schema result');
  assert(chunksTable.columns.some((column) => column.name === 'path'), 'expected chunks.path in schema result');
  assert(chunksTable.sample.length === 1, 'expected one sample row for chunks');
  assert(Object.keys(chunksTable.sample[0])[0] === 'text', `expected schema sample to surface text first, got ${Object.keys(chunksTable.sample[0]).join(', ')}`);

  const sqlSchema = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: "select name from sqlite_master where type = ? order by name",
    params: ['table'],
  }));
  assert(sqlSchema.rows.some((row) => row.name === 'chunks'), 'expected chunks table from manual sqlite_master query');

  const orderedFields = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: 'select id, path, text, source, type from chunks order by id limit 1',
  }));
  assert(Object.keys(orderedFields.rows[0])[0] === 'text', `expected SQL row to surface text first, got ${Object.keys(orderedFields.rows[0]).join(', ')}`);
  assert(Object.keys(orderedFields.rows[0]).at(-1) === 'id', `expected SQL row to put id last, got ${Object.keys(orderedFields.rows[0]).join(', ')}`);

  const blocked = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: "insert into chunks (path, text) values ('x', 'y')",
  }));
  assert(/read-only/i.test(blocked.error || ''), `expected read-only rejection, got ${JSON.stringify(blocked)}`);

  const badQuery = JSON.parse(await executeGoRead({}, {
    action: 'sql',
    path: indexPath,
    sql: 'select missing_column from chunks',
  }));
  assert(/missing_column/i.test(badQuery.error || ''), `expected missing column error, got ${JSON.stringify(badQuery)}`);
  assert(/sql_schema/i.test(badQuery.schemaHint || ''), 'expected schema repair hint');

  const found = await executeGoRead({}, {
    action: 'find',
    argv: [stateDir, '-maxdepth', '3', '-type', 'f', '-name', 'index.db', '-print'],
  });
  assert(found.includes(indexPath), `expected find to locate index.db, got ${found}`);

  const cachePath = join(stateDir, 'brain-cache.json');
  writeFileSync(cachePath, JSON.stringify({
    payload: {
      terms: [
        { id: 'internal-1', path: 'chunks/1', text: 'Campaign Planner', weight: 91, rank: 1 },
        { id: 'internal-2', path: 'chunks/2', text: 'Home Assistant', weight: 72, rank: 2 },
      ],
      empty: [],
    },
  }, null, 2));
  const structuredJson = JSON.parse(await executeGoRead({}, {
    action: 'json',
    path: cachePath,
    maxItems: 5,
  }));
  const termsSummary = structuredJson.primaryData.find((entry) => entry.jsonPath === 'payload.terms');
  assert(termsSummary, `expected payload.terms summary, got ${JSON.stringify(structuredJson)}`);
  assert(termsSummary.items[0].text === 'Campaign Planner', 'expected JSON structured read to preserve text labels');
  assert(Object.keys(termsSummary.items[0])[0] === 'text', `expected JSON item to surface text first, got ${Object.keys(termsSummary.items[0]).join(', ')}`);
  assert(Object.keys(termsSummary.items[0]).at(-1) === 'id', `expected JSON item to put id last, got ${Object.keys(termsSummary.items[0]).join(', ')}`);

  console.log('Go-read SQL test passed.');
  console.log(JSON.stringify({ chunks: count.rows[0].chunks, tables: schema.tables.map((table) => table.name) }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
