/**
 * Brain word cloud generator.
 *
 * JS gathers corpus text and validates structure. The natural-language decision
 * about which words/concepts matter lives in brain-word-cloud.md.
 */

import { runMdPrompt } from './md-llm.js';

const VALID_SOURCES = new Set(['memory', 'notes', 'history']);

function normalizeTerm(row) {
  if (!row || typeof row !== 'object') return null;
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  if (!text) return null;
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
  };
}

function normalizeConnection(row, termTexts) {
  if (!row || typeof row !== 'object') return null;
  const from = typeof row.from === 'string' ? row.from.trim() : '';
  const to = typeof row.to === 'string' ? row.to.trim() : '';
  if (!from || !to || from === to) return null;
  if (!termTexts.has(from) || !termTexts.has(to)) return null;
  const strengthRaw = Number(row.strength);
  const strength = Number.isFinite(strengthRaw)
    ? Math.max(1, Math.min(100, Math.round(strengthRaw)))
    : 1;
  const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 160) : '';
  return { from, to, strength, reason };
}

export async function generateBrainWordCloud({ range, source, corpus } = {}) {
  const result = await runMdPrompt({
    promptName: 'brain-word-cloud',
    user: {
      range,
      source,
      corpus: Array.isArray(corpus) ? corpus : [],
    },
    purpose: 'brain_word_cloud',
  });

  const terms = Array.isArray(result?.terms)
    ? result.terms.map(normalizeTerm).filter(Boolean)
    : [];

  terms.sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text));
  const topTerms = terms.slice(0, 60);
  const termTexts = new Set(topTerms.map((term) => term.text));
  const seen = new Set();
  const connections = Array.isArray(result?.connections)
    ? result.connections.map((row) => normalizeConnection(row, termTexts)).filter(Boolean)
    : [];
  const uniqueConnections = [];
  for (const connection of connections) {
    const key = [connection.from, connection.to].sort().join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueConnections.push(connection);
  }
  uniqueConnections.sort((a, b) => b.strength - a.strength || a.from.localeCompare(b.from));
  return { terms: topTerms, connections: uniqueConnections.slice(0, 120) };
}
