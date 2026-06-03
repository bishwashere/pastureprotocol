/**
 * Projects DB — SQLite store for the dashboard Projects page.
 *
 * Schema:
 *   projects   — project name, optional url, description
 *   updates    — chained update nodes (linked list per track)
 *   branches   — named sub-tracks branching off an update node
 *
 * DB file: $PASTURE_STATE_DIR/projects.db  (default: ~/.pasture/projects.db)
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { getStateDir } from './paths.js';

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  url         TEXT    NOT NULL DEFAULT '',
  description TEXT    NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  parent_update_id INTEGER             REFERENCES updates(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS updates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
  branch_id        INTEGER             REFERENCES branches(id) ON DELETE CASCADE,
  parent_update_id INTEGER             REFERENCES updates(id)  ON DELETE SET NULL,
  text             TEXT    NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_updates_project  ON updates(project_id);
CREATE INDEX IF NOT EXISTS idx_updates_branch   ON updates(branch_id);
CREATE INDEX IF NOT EXISTS idx_branches_project ON branches(project_id);
`;

let _db = null;

function migrateProjectsSchema(db) {
  const cols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!cols.includes('url')) {
    db.exec("ALTER TABLE projects ADD COLUMN url TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('setup_notes')) {
    db.exec("ALTER TABLE projects ADD COLUMN setup_notes TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('connectors_json')) {
    db.exec("ALTER TABLE projects ADD COLUMN connectors_json TEXT NOT NULL DEFAULT '{}'");
  }
}

export function parseProjectConnectors(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function serializeProjectConnectors(connectors) {
  const o = connectors && typeof connectors === 'object' && !Array.isArray(connectors) ? connectors : {};
  return JSON.stringify(o);
}

function mapProjectRow(row) {
  if (!row) return row;
  return {
    ...row,
    connectors: parseProjectConnectors(row.connectors_json),
  };
}

export function normalizeProjectUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

export function getProjectsDb() {
  if (_db) return _db;
  const stateDir = getStateDir();
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, 'projects.db');
  _db = new Database(dbPath);
  _db.exec(SCHEMA);
  migrateProjectsSchema(_db);
  return _db;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function listProjects() {
  const db = getProjectsDb();
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(mapProjectRow);
}

export function getProject(id) {
  return mapProjectRow(getProjectsDb().prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

export function createProject({ name, description = '', url = '', setup_notes = '', connectors = null }) {
  const db = getProjectsDb();
  const now = Date.now();
  const connectorsJson = connectors != null
    ? serializeProjectConnectors(connectors)
    : '{}';
  const result = db.prepare(
    'INSERT INTO projects (name, url, description, setup_notes, connectors_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(name, normalizeProjectUrl(url), description, String(setup_notes || ''), connectorsJson, now, now);
  return getProject(result.lastInsertRowid);
}

export function updateProject(id, { name, description, url, setup_notes, connectors }) {
  const db = getProjectsDb();
  const now = Date.now();
  const existing = getProject(id);
  if (!existing) return null;
  const nextUrl = url !== undefined ? normalizeProjectUrl(url) : (existing.url || '');
  const nextSetup = setup_notes !== undefined ? String(setup_notes || '') : (existing.setup_notes || '');
  const nextName = name !== undefined ? String(name || '').trim() : existing.name;
  const nextDescription = description !== undefined ? String(description || '') : existing.description;
  let nextConnectorsJson = existing.connectors_json || '{}';
  if (connectors !== undefined) {
    const merged = { ...parseProjectConnectors(existing.connectors_json), ...connectors };
    nextConnectorsJson = serializeProjectConnectors(merged);
  }
  db.prepare('UPDATE projects SET name=?, url=?, description=?, setup_notes=?, connectors_json=?, updated_at=? WHERE id=?')
    .run(nextName, nextUrl, nextDescription, nextSetup, nextConnectorsJson, now, id);
  return getProject(id);
}

export function deleteProject(id) {
  getProjectsDb().prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ── Updates ───────────────────────────────────────────────────────────────────

export function getUpdate(id) {
  return getProjectsDb().prepare('SELECT * FROM updates WHERE id = ?').get(id);
}

export function createUpdate({ project_id, branch_id = null, parent_update_id = null, text }) {
  const db = getProjectsDb();
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO updates (project_id, branch_id, parent_update_id, text, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(project_id, branch_id, parent_update_id, text, now);
  // Touch project updated_at
  db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now, project_id);
  return getUpdate(result.lastInsertRowid);
}

export function editUpdate(id, { text }) {
  const db = getProjectsDb();
  db.prepare('UPDATE updates SET text=? WHERE id=?').run(text, id);
  return getUpdate(id);
}

export function deleteUpdate(id) {
  getProjectsDb().prepare('DELETE FROM updates WHERE id = ?').run(id);
}

// ── Branches ──────────────────────────────────────────────────────────────────

export function getBranch(id) {
  return getProjectsDb().prepare('SELECT * FROM branches WHERE id = ?').get(id);
}

export function createBranch({ project_id, parent_update_id = null, name }) {
  const db = getProjectsDb();
  const now = Date.now();
  const result = db.prepare(
    'INSERT INTO branches (project_id, parent_update_id, name, created_at) VALUES (?, ?, ?, ?)'
  ).run(project_id, parent_update_id, name, now);
  return getBranch(result.lastInsertRowid);
}

export function deleteBranch(id) {
  getProjectsDb().prepare('DELETE FROM branches WHERE id = ?').run(id);
}

// ── Full project graph ────────────────────────────────────────────────────────
// Returns all updates + branches for a project so the UI can render the tree.

export function getProjectGraph(project_id) {
  const db = getProjectsDb();
  const project  = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
  if (!project) return null;
  const updates  = db.prepare('SELECT * FROM updates  WHERE project_id = ? ORDER BY created_at ASC').all(project_id);
  const branches = db.prepare('SELECT * FROM branches WHERE project_id = ? ORDER BY created_at ASC').all(project_id);
  return { project, updates, branches };
}
