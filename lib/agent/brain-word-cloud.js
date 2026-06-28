/**
 * Brain graph chunk generator.
 *
 * JS gathers corpus text and validates structure. The natural-language decision
 * about which concepts matter, which words to exclude, and how relations should
 * be weighted lives in brain-word-cloud.md.
 */

import { runMdPrompt } from './md-llm.js';

const VALID_SOURCES = new Set(['memory', 'notes', 'history']);
const BLOCKED_TERM_TEXT = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their',
  'them', 'then', 'there', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'who', 'why', 'will', 'with', 'you', 'your',
  'user', 'assistant', 'system', 'human', 'message', 'messages', 'chat',
  'conversation', 'reply', 'response',
]);

function isUsefulBrainTermText(text) {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return false;
  const words = normalized.split(' ').filter(Boolean);
  if (words.length > 4) return false;
  const lower = normalized.toLowerCase();
  if (BLOCKED_TERM_TEXT.has(lower)) return false;
  if (words.every((word) => BLOCKED_TERM_TEXT.has(word.toLowerCase()))) return false;
  return true;
}

function normalizeTerm(row) {
  if (!row || typeof row !== 'object') return null;
  const text = typeof row.text === 'string' ? row.text.trim().replace(/\s+/g, ' ') : '';
  if (!isUsefulBrainTermText(text)) return null;
  const weightRaw = Number(row.weight);
  const weight = Number.isFinite(weightRaw)
    ? Math.max(1, Math.min(100, Math.round(weightRaw)))
    : 1;
  const sources = Array.isArray(row.sources)
    ? row.sources.map((s) => String(s || '').trim()).filter((s) => VALID_SOURCES.has(s))
    : [];
  return {
    text: text.slice(0, 60),
    weight,
    sources: sources.length ? [...new Set(sources)] : ['memory'],
    kind: typeof row.kind === 'string' ? row.kind.trim().slice(0, 40) : 'concept',
  };
}

function normalizeConnection(row, canonicalTerms) {
  if (!row || typeof row !== 'object') return null;
  const rawFrom = typeof row.from === 'string' ? row.from.trim().replace(/\s+/g, ' ') : '';
  const rawTo = typeof row.to === 'string' ? row.to.trim().replace(/\s+/g, ' ') : '';
  const from = canonicalTerms.get(rawFrom.toLowerCase()) || '';
  const to = canonicalTerms.get(rawTo.toLowerCase()) || '';
  if (!from || !to || from === to) return null;
  const strengthRaw = Number(row.strength);
  const strength = Number.isFinite(strengthRaw)
    ? Math.max(1, Math.min(100, Math.round(strengthRaw)))
    : 1;
  const weightRaw = Number(row.weight);
  const weight = Number.isFinite(weightRaw)
    ? Math.max(0, Math.min(100, Number(weightRaw.toFixed ? weightRaw.toFixed(3) : weightRaw)))
    : strength;
  const evidenceRaw = Number(row.evidence);
  const evidence = Number.isFinite(evidenceRaw) ? Math.max(0, Number(evidenceRaw.toFixed ? evidenceRaw.toFixed(3) : evidenceRaw)) : weight;
  const decayRaw = Number(row.decay);
  const decay = Number.isFinite(decayRaw) ? Math.max(0, Number(decayRaw.toFixed ? decayRaw.toFixed(3) : decayRaw)) : 0;
  const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 160) : '';
  return { from, to, strength, weight, evidence, decay, reason };
}

export async function generateBrainChunkGraph({ range, source, chunk } = {}) {
  const result = await runMdPrompt({
    promptName: 'brain-word-cloud',
    user: {
      range,
      source,
      chunk: chunk && typeof chunk === 'object' ? chunk : {},
    },
    purpose: 'brain_word_cloud',
  });

  const terms = Array.isArray(result?.terms)
    ? result.terms.map(normalizeTerm).filter(Boolean)
    : [];

  terms.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const topTerms = terms.slice(0, 80);
  const canonicalTerms = new Map(topTerms.map((term) => [term.text.toLowerCase(), term.text]));
  const seen = new Set();
  const connections = Array.isArray(result?.connections)
    ? result.connections.map((row) => normalizeConnection(row, canonicalTerms)).filter(Boolean)
    : [];
  const uniqueConnections = [];
  for (const connection of connections) {
    const key = [connection.from, connection.to].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueConnections.push(connection);
  }
  uniqueConnections.sort((a, b) => b.strength - a.strength || a.from.localeCompare(b.from));
  return { terms: topTerms, connections: uniqueConnections.slice(0, 180) };
}

export async function refineBrainGraphQuality({ range, source, graph, stats } = {}) {
  const termsIn = Array.isArray(graph?.terms) ? graph.terms.slice(0, 260) : [];
  const termSet = new Set(termsIn.map((term) => String(term?.text || '').trim()).filter(Boolean));
  const connectionsIn = Array.isArray(graph?.connections)
    ? graph.connections
      .filter((connection) => termSet.has(connection?.from) && termSet.has(connection?.to))
      .slice(0, 900)
    : [];

  const result = await runMdPrompt({
    promptName: 'brain-graph-quality',
    user: {
      range,
      source,
      stats: stats && typeof stats === 'object' ? stats : {},
      graph: {
        terms: termsIn,
        connections: connectionsIn,
      },
    },
    purpose: 'brain_graph_quality',
  });

  const terms = Array.isArray(result?.terms)
    ? result.terms.map(normalizeTerm).filter(Boolean)
    : [];

  terms.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const topTerms = terms.slice(0, 220);
  const canonicalTerms = new Map(topTerms.map((term) => [term.text.toLowerCase(), term.text]));
  const seen = new Set();
  const connections = Array.isArray(result?.connections)
    ? result.connections.map((row) => normalizeConnection(row, canonicalTerms)).filter(Boolean)
    : [];
  const uniqueConnections = [];
  for (const connection of connections) {
    const key = [connection.from, connection.to].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueConnections.push(connection);
  }
  uniqueConnections.sort((a, b) => b.strength - a.strength || a.from.localeCompare(b.from));
  return { terms: topTerms, connections: uniqueConnections.slice(0, 900) };
}

export async function generateBrainWordCloud({ range, source, corpus } = {}) {
  const text = Array.isArray(corpus)
    ? corpus.map((chunk) => String(chunk?.text || '')).join('\n\n')
    : '';
  return generateBrainChunkGraph({
    range,
    source,
    chunk: {
      source,
      label: 'combined corpus',
      text,
    },
  });
}
