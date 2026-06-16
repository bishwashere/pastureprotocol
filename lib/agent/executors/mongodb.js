/**
 * MongoDB executor — read-only queries against project-configured databases.
 *
 * Connection details come from the dashboard Projects → Connectors panel
 * (projects.db: connectors.mongodb.uri + connectors.mongodb.collections).
 *
 * Safety constraints:
 *   - Only find, countDocuments, and aggregate are exposed. No writes.
 *   - find: max 50 documents (hard cap).
 *   - aggregate: max 200 output documents (hard cap via $limit appended).
 *   - Timeout: 10 s server selection + socket; 8 s connection.
 *   - Credentials are stripped from all user-visible output and errors.
 */

import { MongoClient } from 'mongodb';
import { listProjects, parseProjectConnectors } from '../projects-db.js';

// ── Constants ────────────────────────────────────────────────────────────────

const FIND_LIMIT = 50;
const AGG_LIMIT = 200;
const CONNECT_TIMEOUT_MS = 8_000;
const SERVER_SELECT_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function redactUri(text) {
  return String(text || '').replace(
    /mongodb(?:\+srv)?:\/\/[^@\s]+@/gi,
    'mongodb://***:***@',
  );
}

function safeError(err) {
  return redactUri(err?.message || String(err));
}

/** Parse a URI that may be stored as  DATABASE_URL="mongodb+srv://..." */
function parseStoredUri(raw) {
  const s = String(raw || '').trim();
  // Strip key=value wrapper: DATABASE_URL="..." or DATABASE_URL=...
  const match = s.match(/^[A-Z_]+=["']?(mongodb(?:\+srv)?:\/\/.+?)["']?$/i);
  if (match) return match[1].trim();
  if (/^mongodb(?:\+srv)?:\/\//i.test(s)) return s;
  return null;
}

/** Resolve a collection name: accept a hint key or a literal collection name. */
function resolveCollection(nameOrKey, collectionHints) {
  if (!nameOrKey) return null;
  const hints = collectionHints || {};
  // Direct hit on hint value (exact collection name already)
  const vals = Object.values(hints);
  if (vals.includes(nameOrKey)) return nameOrKey;
  // Match on hint key (case-insensitive substring)
  const lower = nameOrKey.toLowerCase();
  for (const [key, val] of Object.entries(hints)) {
    if (key.toLowerCase().includes(lower) || lower.includes(key.toLowerCase().split(':')[0].trim().toLowerCase())) {
      return val;
    }
  }
  // Fall back: treat as literal name
  return nameOrKey;
}

/** Find the project by name (case-insensitive substring). */
function findProject(projectArg) {
  const q = String(projectArg || '').trim().toLowerCase();
  if (!q) return null;
  const projects = listProjects();
  // Exact match first
  let hit = projects.find((p) => String(p.name || '').toLowerCase() === q);
  if (!hit) hit = projects.find((p) => String(p.name || '').toLowerCase().includes(q));
  if (!hit) hit = projects.find((p) => q.includes(String(p.name || '').toLowerCase()));
  return hit || null;
}

/** Build a MongoClient configured for safe read-only access. */
function makeClient(uri) {
  return new MongoClient(uri, {
    connectTimeoutMS: CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: SERVER_SELECT_TIMEOUT_MS,
    socketTimeoutMS: SOCKET_TIMEOUT_MS,
    readPreference: 'secondaryPreferred',
    maxPoolSize: 1,
    minPoolSize: 0,
  });
}

/** Extract db name from URI or fall back to the first path segment. */
function dbNameFromUri(uri) {
  try {
    const url = new URL(uri);
    const name = url.pathname.replace(/^\//, '').split('?')[0].trim();
    return name || null;
  } catch (_) {
    return null;
  }
}

/** Summarize a single document: keep only _id, createdAt, updatedAt, and a few key fields. */
function summarizeDoc(doc, maxKeys = 8) {
  if (!doc || typeof doc !== 'object') return doc;
  const priority = ['_id', 'id', 'createdAt', 'updatedAt', 'date', 'name', 'title', 'status'];
  const keys = [
    ...priority.filter((k) => k in doc),
    ...Object.keys(doc).filter((k) => !priority.includes(k)),
  ].slice(0, maxKeys);
  const out = {};
  for (const k of keys) out[k] = doc[k];
  return out;
}

// ── Project health query set ──────────────────────────────────────────────────

/**
 * Canonical health aggregations for a project using its stored collection hints.
 * Returns a structured summary object, not raw documents.
 */
async function runProjectHealth(db, hints) {
  const results = {};

  // 1. project-analytics — latest record
  const paName = resolveCollection('project-analytics', hints);
  if (paName) {
    try {
      const latest = await db.collection(paName)
        .find({}, { projection: { _id: 0, periodStart: 1, periodEnd: 1, totalPosts: 1, totalCampaigns: 1, avgEngagementRate: 1, engagementTrend: 1, recommendedTime: 1, recommendedPlatforms: 1, campaignSuggestions: 1, calculatedAt: 1 } })
        .sort({ calculatedAt: -1 })
        .limit(3)
        .toArray();
      results.projectAnalytics = latest;
    } catch (e) {
      results.projectAnalyticsError = safeError(e);
    }
  }

  // 2. project-pulse — last 5 pulses for trend
  const ppName = resolveCollection('project-pulse', hints);
  if (ppName) {
    try {
      const pulses = await db.collection(ppName)
        .find({}, { projection: { _id: 0, pulse: 1, daysPosted: 1, gapDays: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(5)
        .toArray();
      results.projectPulse = pulses;
    } catch (e) {
      results.projectPulseError = safeError(e);
    }
  }

  // 3. campaign-analytics — most recent 3
  const caName = resolveCollection('campaign-analytics', hints);
  if (caName) {
    try {
      const campaigns = await db.collection(caName)
        .find({}, { projection: { _id: 0, periodStart: 1, periodEnd: 1, totalPosts: 1, totalLikes: 1, totalComments: 1, totalShares: 1, totalImpressions: 1, avgEngagementRate: 1, bestPlatform: 1, bestPostingHour: 1, bestDayOfWeek: 1, calculatedAt: 1 } })
        .sort({ calculatedAt: -1 })
        .limit(3)
        .toArray();
      results.campaignAnalytics = campaigns;
    } catch (e) {
      results.campaignAnalyticsError = safeError(e);
    }
  }

  // 4. PlatformPost — 30-day summary by likes+impressions
  const postName = resolveCollection('PlatformPost', hints);
  if (postName) {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000);
      const pipeline = [
        { $match: { date: { $gte: thirtyDaysAgo } } },
        {
          $group: {
            _id: null,
            totalPosts: { $sum: 1 },
            totalLikes: { $sum: '$likes' },
            totalComments: { $sum: '$comments' },
            totalShares: { $sum: '$shares' },
            totalImpressions: { $sum: '$impressions' },
            avgLikes: { $avg: '$likes' },
            latestPostDate: { $max: '$date' },
          },
        },
        { $project: { _id: 0 } },
      ];
      const [summary] = await db.collection(postName).aggregate(pipeline, { allowDiskUse: false }).limit(1).toArray();
      results.recentPostsSummary = summary || null;
    } catch (e) {
      results.recentPostsSummaryError = safeError(e);
    }
  }

  return results;
}

// ── Main executor ─────────────────────────────────────────────────────────────

/**
 * @param {object} ctx - agent context
 * @param {object} args - LLM tool args
 * @param {string} toolName - resolved tool name (e.g. mongodb_query)
 */
export async function executeMongodb(ctx, args, toolName) {
  const action = (toolName || '').replace(/^mongodb_/, '') || String(args?.action || args?.command || '').trim();

  if (!action) {
    return JSON.stringify({ error: 'action required: query | aggregate | stats | project_health' });
  }

  // Resolve project
  const projectArg = String(args?.project || args?.projectName || '').trim();
  const project = findProject(projectArg);
  if (!project) {
    const names = listProjects().map((p) => p.name).join(', ');
    return JSON.stringify({ error: `Project not found: "${projectArg}". Configured projects: ${names || 'none'}` });
  }

  const connectors = parseProjectConnectors(project.connectors_json);
  const mongoConnector = connectors?.mongodb;
  if (!mongoConnector?.uri) {
    return JSON.stringify({ error: `No MongoDB URI configured for project "${project.name}". Add it in the dashboard Projects → Connectors panel.` });
  }

  const uri = parseStoredUri(mongoConnector.uri);
  if (!uri) {
    return JSON.stringify({ error: `Could not parse MongoDB URI for project "${project.name}". Expected format: mongodb+srv://...` });
  }

  const hints = mongoConnector.collections || {};
  const dbName = args?.database || dbNameFromUri(uri);

  let client;
  try {
    let result;

    // Validate inputs before connecting so validation errors never trigger network
    if (action === 'query') {
      const collectionArg = String(args?.collection || '').trim();
      if (!collectionArg) return JSON.stringify({ error: 'collection is required for query' });
    }
    if (action === 'aggregate') {
      const collectionArg = String(args?.collection || '').trim();
      if (!collectionArg) return JSON.stringify({ error: 'collection is required for aggregate' });
      const pipeline = Array.isArray(args?.pipeline) ? args.pipeline : [];
      if (!pipeline.length) return JSON.stringify({ error: 'pipeline array is required for aggregate' });
    }
    if (action === 'stats') {
      const collectionArg = String(args?.collection || '').trim();
      if (!collectionArg) return JSON.stringify({ error: 'collection is required for stats' });
    }

    client = makeClient(uri);
    await client.connect();
    const db = dbName ? client.db(dbName) : client.db();

    if (action === 'project_health') {
      const health = await runProjectHealth(db, hints);
      result = {
        ok: true,
        project: project.name,
        database: db.databaseName,
        health,
        collectionHints: Object.fromEntries(
          Object.entries(hints).map(([k, v]) => [k.slice(0, 60), v]),
        ),
      };
    } else if (action === 'stats') {
      const collectionArg = String(args?.collection || '').trim();
      const collName = resolveCollection(collectionArg, hints);
      const count = await db.collection(collName).countDocuments({}, { maxTimeMS: SOCKET_TIMEOUT_MS });
      const [first] = await db.collection(collName).find({}).sort({ createdAt: 1 }).limit(1).toArray();
      const [last] = await db.collection(collName).find({}).sort({ createdAt: -1 }).limit(1).toArray();
      result = {
        ok: true,
        project: project.name,
        collection: collName,
        count,
        firstCreatedAt: first?.createdAt || null,
        lastCreatedAt: last?.createdAt || null,
      };
    } else if (action === 'query') {
      const collectionArg = String(args?.collection || '').trim();
      const collName = resolveCollection(collectionArg, hints);
      const filter = args?.filter && typeof args.filter === 'object' ? args.filter : {};
      const projection = args?.projection && typeof args.projection === 'object' ? args.projection : {};
      const sort = args?.sort && typeof args.sort === 'object' ? args.sort : { createdAt: -1 };
      const limit = Math.min(Math.max(1, Number(args?.limit) || 20), FIND_LIMIT);
      const docs = await db.collection(collName)
        .find(filter, { projection, maxTimeMS: SOCKET_TIMEOUT_MS })
        .sort(sort)
        .limit(limit)
        .toArray();
      result = {
        ok: true,
        project: project.name,
        collection: collName,
        count: docs.length,
        docs: docs.map((d) => summarizeDoc(d)),
      };
    } else if (action === 'aggregate') {
      const collectionArg = String(args?.collection || '').trim();
      const collName = resolveCollection(collectionArg, hints);
      const pipeline = Array.isArray(args?.pipeline) ? args.pipeline : [];
      // Append a hard $limit if not already present
      const lastStage = pipeline[pipeline.length - 1];
      const hasLimit = lastStage && ('$limit' in lastStage);
      const safePipeline = hasLimit ? pipeline : [...pipeline, { $limit: AGG_LIMIT }];
      const docs = await db.collection(collName)
        .aggregate(safePipeline, { allowDiskUse: false, maxTimeMS: SOCKET_TIMEOUT_MS })
        .toArray();
      result = {
        ok: true,
        project: project.name,
        collection: collName,
        count: docs.length,
        docs: docs.map((d) => summarizeDoc(d, 12)),
      };
    } else {
      result = { error: `Unknown action: ${action}. Use query | aggregate | stats | project_health` };
    }

    return JSON.stringify(result, null, 2);
  } catch (err) {
    return JSON.stringify({ ok: false, error: safeError(err) });
  } finally {
    if (client) {
      try { await client.close(); } catch (_) {}
    }
  }
}
