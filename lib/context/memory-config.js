/**
 * Resolve memory feature config from config.json.
 * When memory.embedding is not set: use OpenAI if key is available, otherwise use local (Ollama).
 */

import { readFileSync } from 'fs';
import { getConfigPath, getWorkspaceDir, getMemoryIndexPath } from './paths.js';

const EMBEDDING_PRESETS = {
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
};

const DEFAULT_EMBEDDING_MODELS = {
  openai: 'text-embedding-3-small',
  grok: 'grok-2-embedding',
  xai: 'grok-2-embedding',
  together: 'togethercomputer/m2-bert-80M-8k-retrieval',
  deepseek: 'deepseek-embedding',
  ollama: 'nomic-embed-text',
  lmstudio: 'local',
};

function fromEnv(val) {
  if (val == null) return val;
  const s = String(val).trim();
  if (process.env[s] !== undefined) return process.env[s];
  return val;
}

/**
 * Load raw config object from config.json.
 * @returns {Record<string, unknown>}
 */
function loadRawConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    if (!raw?.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Resolve OpenAI API key from env or LLM config. Returns key string or null.
 * Exported for use by speech (Whisper fallback).
 */
export function getOpenAIKey(raw) {
  const k = process.env.OPENAI_API_KEY && String(process.env.OPENAI_API_KEY).trim();
  if (k) return k;
  const llm = raw.llm && typeof raw.llm === 'object' ? raw.llm : {};
  const models = Array.isArray(llm.models) ? llm.models : [];
  for (const m of models) {
    if (m && String(m.provider || '').toLowerCase() === 'openai') {
      const key = fromEnv(m.apiKey);
      if (key && String(key).trim() && String(key) !== 'not-needed') return key;
    }
  }
  const key = fromEnv('LLM_API_KEY');
  if (key && String(key).trim() && String(key) !== 'not-needed') return key;
  return null;
}

/**
 * Get resolved memory config. Returns null if memory is disabled or not configured.
 * When memory.embedding is missing: use OpenAI if key available, else local (Ollama).
 * @param {Record<string, unknown>} [config] - Full config (if not provided, loads from getConfigPath).
 * @returns {{
 *   workspaceDir: string,
 *   indexPath: string,
 *   embedding: { baseUrl: string, apiKey: string, model: string },
 *   chunking: { tokens: number, overlap: number },
 *   search: { maxResults: number, minScore: number },
 *   sync: { onSearch: boolean, watch: boolean }
 * } | null}
 */
export function getMemoryConfig(config = null) {
  const raw = config ?? loadRawConfig();
  const skills = raw.skills && typeof raw.skills === 'object' ? raw.skills : {};
  const enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
  if (!enabled.includes('memory')) return null;

  const memory = raw.memory && typeof raw.memory === 'object' ? raw.memory : {};
  if (memory.enabled === false) return null;

  const workspaceDir = (memory.workspaceDir && String(memory.workspaceDir).trim()) || getWorkspaceDir();
  const indexPath = (memory.indexPath && String(memory.indexPath).trim()) || getMemoryIndexPath();

  // Embedding: from memory.embedding, or OpenAI if key available, else local (Ollama)
  let baseUrl, apiKey, model;
  const emb = memory.embedding && typeof memory.embedding === 'object' ? memory.embedding : {};
  const provider = (emb.provider && String(emb.provider).toLowerCase()) || null;
  if (provider && EMBEDDING_PRESETS[provider] !== undefined) {
    baseUrl = fromEnv(emb.baseUrl) || EMBEDDING_PRESETS[provider];
    apiKey = fromEnv(emb.apiKey) ?? fromEnv('LLM_API_KEY');
    model = fromEnv(emb.model) || DEFAULT_EMBEDDING_MODELS[provider] || 'text-embedding-3-small';
  } else {
    const openaiKey = getOpenAIKey(raw);
    if (openaiKey) {
      baseUrl = EMBEDDING_PRESETS.openai;
      apiKey = openaiKey;
      model = fromEnv(emb.model) || DEFAULT_EMBEDDING_MODELS.openai;
    } else {
      baseUrl = EMBEDDING_PRESETS.ollama;
      apiKey = 'not-needed';
      model = fromEnv(emb.model) || DEFAULT_EMBEDDING_MODELS.ollama;
    }
  }

  const chunking = memory.chunking && typeof memory.chunking === 'object' ? memory.chunking : {};
  const search = memory.search && typeof memory.search === 'object' ? memory.search : {};
  const sync = memory.sync && typeof memory.sync === 'object' ? memory.sync : {};

  return {
    workspaceDir,
    indexPath,
    embedding: {
      baseUrl: (baseUrl || '').replace(/\/$/, ''),
      apiKey: apiKey || '',
      model: model || 'text-embedding-3-small',
    },
    chunking: {
      tokens: Math.max(100, Math.min(2000, Number(chunking.tokens) || 512)),
      overlap: Math.max(0, Math.min(100, Number(chunking.overlap) || 32)),
    },
    search: {
      maxResults: Math.max(1, Math.min(20, Number(search.maxResults) || 6)),
      minScore: Number(search.minScore) || 0,
    },
    sync: {
      onSearch: sync.onSearch !== false,
      watch: sync.watch !== false,
    },
  };
}
