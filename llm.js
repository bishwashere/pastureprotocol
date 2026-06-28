/**
 * Configurable LLM client. All config values are read from .env (keys in config.json
 * are env var names). Supports preset providers and multiple models with priority.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getConfigPath, getUploadsDir, getAgentConfigPath, getLlmUsagePath } from './lib/util/paths.js';
import { DEFAULT_AGENT_ID } from './lib/agent/agent-config.js';
import { beginLlmCall, endLlmCall, getActiveTrace } from './lib/util/request-timing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Daily cloud LLM rate limiter
// Only cloud (non-local) calls count. Local models (ollama/lmstudio on 127.x)
// are free and never blocked. Counter resets at midnight UTC.
// Override the cap via config.json: { "llm": { "dailyLimit": 200 } }
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Local LLM per-minute rate limiter
// Limits how many requests per minute are sent to local models (ollama/lmstudio).
// Default: 1 request per minute. If a second request arrives before the window
// expires, it is rejected immediately (not queued).
// Override via config.json: { "llm": { "localRpm": 5 } }
// ---------------------------------------------------------------------------

export const DEFAULT_LOCAL_RPM = 1;

/** Timestamp (ms) of the most recent local LLM call for each baseUrl. */
const _localLastCallMs = new Map();
/** How many distinct messages have been admitted in the current window for each baseUrl. */
const _localWindowCount = new Map();
/** Start of the current 60-second window for each baseUrl. */
const _localWindowStart = new Map();
/**
 * The trace ID (message/request) that was admitted into the current window for each baseUrl.
 * All LLM calls sharing this trace ID are free — only a second *distinct* message is rate-limited.
 */
const _localAdmittedTraceId = new Map();

/**
 * Check local RPM limit for a given baseUrl.
 * The limit is per *message* (request trace), not per individual LLM call.
 * All LLM calls that belong to the same top-level message are allowed freely once
 * that message has been admitted. Only a second distinct message within the same
 * 60-second window is rejected.
 * Throws with code 'LLM_LOCAL_RATE_LIMIT' if the limit is exceeded.
 * @param {string} baseUrl
 * @param {number} rpm  Messages per minute allowed (0 = unlimited)
 * @param {string|null} traceId  Active request trace ID (from getActiveTrace)
 */
export function checkLocalRateLimit(baseUrl, rpm, traceId = null) {
  const limit = Number(rpm);
  if (!limit || limit <= 0) return; // 0 = unlimited

  const key = String(baseUrl || '').toLowerCase();
  const now = Date.now();
  const windowStart = _localWindowStart.get(key) || 0;
  const windowAge = now - windowStart;

  if (windowAge >= 60_000) {
    // New window — admit this message
    _localWindowStart.set(key, now);
    _localWindowCount.set(key, 1);
    _localLastCallMs.set(key, now);
    if (traceId) _localAdmittedTraceId.set(key, traceId);
    return;
  }

  // If this call belongs to the already-admitted message, let it through for free
  const admittedTrace = _localAdmittedTraceId.get(key);
  if (traceId && admittedTrace && traceId === admittedTrace) {
    _localLastCallMs.set(key, now);
    return;
  }

  // New message arriving within the same window — check against the limit
  const count = (_localWindowCount.get(key) || 0) + 1;
  if (count > limit) {
    const msLeft = 60_000 - windowAge;
    const err = new Error(
      `Local LLM rate limit reached (${limit} req/min). Try again in ${Math.ceil(msLeft / 1000)}s.`,
    );
    err.code = 'LLM_LOCAL_RATE_LIMIT';
    err.msUntilReset = msLeft;
    throw err;
  }

  _localWindowCount.set(key, count);
  _localLastCallMs.set(key, now);
  if (traceId) _localAdmittedTraceId.set(key, traceId);
}

/** True when the error is a local RPM limit hit. */
export function isLocalRateLimitError(err) {
  return (
    err?.code === 'LLM_LOCAL_RATE_LIMIT' ||
    /Local LLM rate limit reached/i.test(err?.message || '')
  );
}

/** Milliseconds remaining in the current local RPM window for a given baseUrl, or 0 if no active window. */
export function localRpmMsUntilReset(baseUrl) {
  const key = String(baseUrl || '').toLowerCase();
  const windowStart = _localWindowStart.get(key) || 0;
  if (!windowStart) return 0;
  const age = Date.now() - windowStart;
  return age >= 60_000 ? 0 : 60_000 - age;
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function readUsage() {
  try {
    const raw = readFileSync(getLlmUsagePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && data.date === todayUTC()) return { date: data.date, count: Number(data.count) || 0 };
  } catch (_) {}
  return { date: todayUTC(), count: 0 };
}

function writeUsage(usage) {
  try {
    writeFileSync(getLlmUsagePath(), JSON.stringify(usage), 'utf8');
  } catch (_) {}
}

/**
 * Module-level flag: the UTC date string ('YYYY-MM-DD') on which the daily limit was first hit,
 * or null when not yet hit today. Automatically stale the moment the date rolls over.
 */
let _dailyLimitReachedDate = null;

/**
 * Check and increment the daily cloud LLM counter.
 * Throws a non-retryable error with code 'LLM_DAILY_LIMIT' if the cap is reached.
 */
function checkAndTrackCloudLimit(dailyLimit = DEFAULT_DAILY_LIMIT) {
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : DEFAULT_DAILY_LIMIT;
  const usage = readUsage();
  if (usage.count >= limit) {
    _dailyLimitReachedDate = todayUTC();
    const err = new Error(
      `Daily cloud LLM limit reached (${usage.count}/${limit} calls today). Resets at midnight UTC. Local models are unaffected.`,
    );
    err.code = 'LLM_DAILY_LIMIT';
    throw err;
  }
  usage.count += 1;
  writeUsage(usage);
  console.log(`[LLM] daily usage: ${usage.count}/${limit}`);
}

/**
 * Returns true if the daily cloud LLM limit has been hit today (UTC).
 * Uses the in-process flag (fast path) and falls back to reading the usage file
 * (handles daemon restarts, multi-process, and cases where the limit was hit before
 * the current process started).
 * Local models are never limited and this always returns false for them.
 */
export function isDailyLimitReached() {
  if (_dailyLimitReachedDate === todayUTC()) return true;
  try {
    const usage = readUsage();
    if (usage.count >= DEFAULT_DAILY_LIMIT) {
      _dailyLimitReachedDate = todayUTC();
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Milliseconds until the daily limit resets (midnight UTC).
 * Useful for logging "try again in X hours".
 */
export function msUntilLimitResets() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

/**
 * True when the error is a daily-limit hit — works across process boundaries
 * (child processes lose err.code; check the message text too).
 */
export function isDailyLimitError(err) {
  return (
    (err?.code === 'LLM_DAILY_LIMIT') ||
    /Daily cloud LLM limit reached/i.test(err?.message || '')
  );
}

/** When a cloud model hits the daily cap, fall through to the next model (usually local). */
function isDailyLimitFallbackError(err) {
  return err?.code === 'LLM_DAILY_LIMIT';
}

/** Cloud retries before falling back to the next model (local). */
export const CLOUD_MAX_ATTEMPTS = 3;
const CLOUD_RETRY_DELAYS_MS = [600, 1800];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeLlmError(message = '', max = 160) {
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** True for transient provider/network failures worth retrying on the same model. */
export function isTransientCloudError(err) {
  if (!err || isDailyLimitError(err) || isLocalRateLimitError(err)) return false;
  const msg = String(err?.message || err || '');
  if (/LLM request failed 401\b/i.test(msg)) return false;
  if (/invalid api key|incorrect api key|authentication header/i.test(msg)) return false;
  if (/LLM request failed 400\b/i.test(msg)) return false;
  if (/LLM request failed 404\b/i.test(msg)) return false;
  if (/LLM request failed 431\b/i.test(msg)) return false;
  if (/model not found|invalid argument/i.test(msg)) return false;
  if (/LLM request failed 429\b/i.test(msg)) return true;
  if (/LLM request failed 5\d\d\b/i.test(msg)) return true;
  if (/520|503|502|504|529|upstream connect|connection termination|fetch failed|ECONNRESET|ETIMEDOUT|network error|socket hang up/i.test(msg)) {
    return true;
  }
  return false;
}

async function runModelWithRetries({
  label,
  isLocal,
  llmCtx,
  toolCount = 0,
  callFactory,
  parseOkResponse,
}) {
  const maxAttempts = isLocal ? 1 : CLOUD_MAX_ATTEMPTS;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await callFactory({ countUsage: attempt === 1 });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM request failed ${res.status}: ${text}`);
      }
      const parsed = await parseOkResponse(res);
      if (attempt > 1) {
        console.log(`[LLM] used: ${label} (after ${attempt} attempts${toolCount ? ', with tools' : ''})`);
      } else {
        console.log(`[LLM] used: ${label}${toolCount ? ' (with tools)' : ''}`);
      }
      endLlmCall(llmCtx, {
        model: label,
        status: 'ok',
        toolCount,
        detail: { attempts: attempt, ...(parsed.detail || {}) },
      });
      return parsed.result;
    } catch (err) {
      lastError = err;
      if (isLocalRateLimitError(err)) throw err;
      if (isDailyLimitFallbackError(err)) throw err;
      const canRetry = !isLocal && attempt < maxAttempts && isTransientCloudError(err);
      if (canRetry) {
        const delay = CLOUD_RETRY_DELAYS_MS[attempt - 1] || 2000;
        console.log(
          `[LLM] transient error on ${label} (attempt ${attempt}/${maxAttempts}), retry in ${delay}ms:`,
          summarizeLlmError(err?.message),
        );
        await sleep(delay);
        continue;
      }
      endLlmCall(llmCtx, {
        model: label,
        status: 'error',
        message: err?.message || String(err),
        toolCount,
        detail: { attempts: attempt },
      });
      throw err;
    }
  }
  throw lastError || new Error('LLM call failed');
}

// ---------------------------------------------------------------------------

/** If config value is an env var name (e.g. "LLM_API_KEY"), return process.env[value]; else return value. */
function fromEnv(val) {
  if (val == null) return val;
  const s = String(val).trim();
  if (process.env[s] !== undefined) return process.env[s];
  return val;
}

/** Preset base URLs for standard providers (OpenAI-compatible except Anthropic). */
const PRESETS = {
  openai: 'https://api.openai.com/v1',
  grok: 'https://api.x.ai/v1',
  xai: 'https://api.x.ai/v1',
  together: 'https://api.together.xyz/v1',
  deepseek: 'https://api.deepseek.com/v1',
  anthropic: 'https://api.anthropic.com',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
};

/** Only local providers can have baseUrl in config.json; others use preset only. */
const LOCAL_PROVIDERS = new Set(['lmstudio', 'ollama']);

/** Agent LLM priority: inherit project order, or use per-agent model flags. */
export const LLM_PRIORITY_SYSTEM = 'system';
export const LLM_PRIORITY_CUSTOM = 'custom';
export const DEFAULT_LLM_PRIORITY_MODE = LLM_PRIORITY_SYSTEM;

function entryHasPriority(entry) {
  return entry?.priority === true || entry?.priority === 1 ||
    String(entry?.priority).toLowerCase() === 'true' || entry?.priority === '1';
}

function normalizePriorityMode(mode) {
  const raw = String(mode || DEFAULT_LLM_PRIORITY_MODE).trim().toLowerCase();
  return raw === LLM_PRIORITY_CUSTOM ? LLM_PRIORITY_CUSTOM : LLM_PRIORITY_SYSTEM;
}

function readRootConfigRaw() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    if (raw && raw.trim()) return JSON.parse(raw);
  } catch (_) {}
  return {};
}

function providerOrderFromEntries(entries) {
  const ordered = [...entries];
  const priorityIndex = ordered.findIndex((entry) => entryHasPriority(entry));
  if (priorityIndex >= 0) {
    const [priorityEntry] = ordered.splice(priorityIndex, 1);
    ordered.unshift(priorityEntry);
  }
  const providers = [];
  for (const entry of ordered) {
    const provider = String(entry?.provider || '').trim().toLowerCase();
    if (provider && !providers.includes(provider)) providers.push(provider);
  }
  return providers;
}

/** Reorder agent model entries to match the project config's provider priority. */
function reorderEntriesBySystemPriority(agentEntries, systemEntries) {
  const providerOrder = providerOrderFromEntries(systemEntries);
  if (!providerOrder.length) return agentEntries;
  return [...agentEntries].sort((a, b) => {
    const pa = String(a?.provider || '').trim().toLowerCase();
    const pb = String(b?.provider || '').trim().toLowerCase();
    const ia = providerOrder.indexOf(pa);
    const ib = providerOrder.indexOf(pb);
    return (ia >= 0 ? ia : 999) - (ib >= 0 ? ib : 999);
  });
}

/** Env var name for cloud model (e.g. openai -> OPENAI_MODEL). Used when model is omitted in config. */
function cloudModelEnv(provider) {
  if (!provider) return undefined;
  const p = String(provider).toLowerCase();
  const name = p === 'xai' ? 'GROK' : p.toUpperCase();
  return `${name}_MODEL`;
}

/** Default model per provider when the *_MODEL env var is not set. */
const DEFAULT_CLOUD_MODELS = {
  openai: 'gpt-5.2',
  grok: 'grok-4-1-fast-reasoning',
  xai: 'grok-4-1-fast-reasoning',
  anthropic: 'claude-sonnet-4-5-20250929',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  deepseek: 'deepseek-chat',
};

/** Parse optional vision fallback model (used when agent models are text-only). Set in setup; no mid-run prompts. */
function parseVisionFallback(config) {
  const entry = config.skills?.vision?.fallback || config.llm?.vision;
  if (!entry || typeof entry !== 'object') return null;
  const provider = entry.provider && String(entry.provider).toLowerCase();
  const isLocal = provider && LOCAL_PROVIDERS.has(provider);
  const baseUrl = isLocal
    ? (fromEnv(entry.baseUrl) || entry.baseUrl || (provider && PRESETS[provider]))
    : (entry.provider && PRESETS[provider]);
  const apiKey = fromEnv(entry.apiKey) ?? fromEnv('LLM_API_KEY');
  const modelRaw = entry.model != null ? fromEnv(entry.model) : undefined;
  const model = modelRaw || (isLocal ? 'local' : fromEnv(cloudModelEnv(provider))) || fromEnv('LLM_MODEL') || (provider && DEFAULT_CLOUD_MODELS[provider]);
  const maxTokens = Number(fromEnv(entry.maxTokens)) || 1024;
  return { baseUrl: baseUrl || PRESETS.lmstudio, apiKey: apiKey ?? 'not-needed', model: model || 'local', maxTokens };
}

function resolveConfigPath(agentId) {
  const id = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : '';
  if (!id || id === DEFAULT_AGENT_ID) return getConfigPath();
  const perAgent = getAgentConfigPath(id);
  return existsSync(perAgent) ? perAgent : getConfigPath();
}

function loadConfig(options = {}) {
  const agentId = typeof options?.agentId === 'string' && options.agentId.trim()
    ? options.agentId.trim()
    : '';
  const isPerAgentConfig = agentId && agentId !== DEFAULT_AGENT_ID;
  const configPath = resolveConfigPath(options?.agentId);
  let raw = '';
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let config = {};
  if (raw && raw.trim()) {
    try {
      config = JSON.parse(raw);
    } catch (_) {
      // Invalid or truncated config; use defaults below.
    }
  }
  const llm = config.llm || {};
  const priorityMode = isPerAgentConfig
    ? normalizePriorityMode(llm.priorityMode)
    : LLM_PRIORITY_CUSTOM;
  const defaultMaxTokens = Number(fromEnv(llm.maxTokens)) || 100;

  if (Array.isArray(llm.models) && llm.models.length > 0) {
    let modelEntries = llm.models.slice();
    if (isPerAgentConfig && priorityMode === LLM_PRIORITY_SYSTEM) {
      const systemEntries = readRootConfigRaw()?.llm?.models;
      if (Array.isArray(systemEntries) && systemEntries.length > 0) {
        modelEntries = reorderEntriesBySystemPriority(modelEntries, systemEntries);
      }
    }
    let models = modelEntries.map((entry, i) => {
      const provider = entry.provider && String(entry.provider).toLowerCase();
      const isLocal = provider && LOCAL_PROVIDERS.has(provider);
      const baseUrl = isLocal
        ? (fromEnv(entry.baseUrl) || entry.baseUrl || (provider && PRESETS[provider]))
        : (entry.provider && PRESETS[provider]);
      // Resolve apiKey: if the config value is an env var name that isn't set, treat as absent.
      const rawApiKey = entry.apiKey != null ? String(entry.apiKey).trim() : null;
      const isEnvVarName = rawApiKey && /^[A-Z][A-Z0-9_]{2,}$/.test(rawApiKey);
      const resolvedApiKey = isEnvVarName
        ? (process.env[rawApiKey] || null)              // env var name not set → null
        : (rawApiKey || null);                          // literal value (e.g. "not-needed", "sk-...")
      const apiKey = resolvedApiKey ?? (i === 0 ? fromEnv('LLM_API_KEY') : undefined);
      const modelRaw = entry.model != null ? fromEnv(entry.model) : undefined;
      let model = modelRaw || (isLocal ? 'local' : fromEnv(cloudModelEnv(provider))) || (i === 0 ? fromEnv('LLM_MODEL') : undefined);
      if (!isLocal && (!model || model === cloudModelEnv(provider))) {
        model = DEFAULT_CLOUD_MODELS[provider] || model;
      }
      const maxTokens = Number(fromEnv(entry.maxTokens)) || defaultMaxTokens;
      const priority = priorityMode === LLM_PRIORITY_CUSTOM && entryHasPriority(entry);
      return {
        baseUrl: baseUrl || PRESETS.lmstudio,
        apiKey: apiKey ?? 'not-needed',
        model: model || 'local',
        maxTokens,
        priority,
      };
    });
    // Drop cloud models whose API key is missing — don't attempt and get a 401.
    // Local models (lmstudio/ollama on 127.x) are always kept; they don't need a key.
    models = models.filter((m) => {
      const isLocal = m.baseUrl && /127\.0\.0\.1|localhost/i.test(m.baseUrl);
      if (isLocal) return true;
      const hasKey = m.apiKey && m.apiKey !== 'not-needed' && String(m.apiKey).trim() !== '';
      if (!hasKey) console.log('[LLM] skipping model (API key not set):', m.model || m.baseUrl);
      return hasKey;
    });
    // When any model has priority, try it first regardless of position in config.
    const priorityIndex = models.findIndex((m) => m.priority);
    if (priorityIndex >= 0) {
      const [priorityModel] = models.splice(priorityIndex, 1);
      models = [priorityModel, ...models];
    }
    models = models.map(({ priority: _p, ...m }) => m);
    const visionFallback = parseVisionFallback(config);
    const dailyLimit = Number(fromEnv(llm.dailyLimit)) || DEFAULT_DAILY_LIMIT;
    const localRpm = Number(fromEnv(llm.localRpm)) >= 0 ? Number(fromEnv(llm.localRpm)) : DEFAULT_LOCAL_RPM;
    return { models, maxTokens: defaultMaxTokens, visionFallback, dailyLimit, localRpm };
  }

  const baseUrl = fromEnv('LLM_BASE_URL') || fromEnv(llm.baseUrl);
  const apiKey = fromEnv('LLM_API_KEY') ?? fromEnv(llm.apiKey);
  const model = fromEnv('LLM_MODEL') || fromEnv(llm.model);
  const maxTokens = Number(fromEnv(llm.maxTokens)) || 2048;
  const visionFallback = parseVisionFallback(config);
  const dailyLimit = Number(fromEnv(llm.dailyLimit)) || DEFAULT_DAILY_LIMIT;
  const localRpm = Number(fromEnv(llm.localRpm)) >= 0 ? Number(fromEnv(llm.localRpm)) : DEFAULT_LOCAL_RPM;
  return {
    models: [
      {
        baseUrl: baseUrl || PRESETS.lmstudio,
        apiKey: apiKey ?? 'not-needed',
        model: model || 'local',
        maxTokens,
      },
    ],
    maxTokens,
    visionFallback,
    dailyLimit,
    localRpm,
  };
}

/** Call Anthropic Messages API and return a Response-like with OpenAI-shaped JSON. */
async function callAnthropic(messages, { apiKey, model, maxTokens }, tools, purpose) {
  if (!apiKey || apiKey === 'not-needed' || String(apiKey).trim() === '') {
    return { ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ error: { message: 'Anthropic API key not set (set LLM_3_API_KEY in ~/.pasture/.env)' } })) };
  }
  const url = 'https://api.anthropic.com/v1/messages';
  let system = '';
  const anthropicMessages = [];
  for (const m of messages) {
    const role = (m.role || '').toLowerCase();
    const content = typeof m.content === 'string' ? m.content : (m.content && m.content[0]?.text) || '';
    if (role === 'system') {
      system = (system ? system + '\n\n' : '') + content;
      continue;
    }
    if (role === 'user' || role === 'assistant') {
      anthropicMessages.push({ role, content });
    }
  }
  const body = {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: anthropicMessages,
    // Passed through for provider-side observability only; not visible to the model.
    ...(purpose ? { metadata: { user_id: purpose } } : {}),
  };
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey || '',
    'anthropic-version': '2023-06-01',
  };
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    return res;
  }
  const data = await res.json();
  const text = data.content?.find((c) => c.type === 'text')?.text ?? '';
  const openaiShape = { choices: [{ message: { content: text, tool_calls: [] } }] };
  return {
    ok: true,
    status: res.status,
    json: () => Promise.resolve(openaiShape),
    text: () => Promise.resolve(JSON.stringify(openaiShape)),
  };
}

/** OpenAI newer models (e.g. GPT-5.x) require max_completion_tokens instead of max_tokens. */
function openaiUsesMaxCompletionTokens(model) {
  return typeof model === 'string' && /^gpt-5/.test(model);
}

function callOne(messages, { baseUrl, apiKey, model, maxTokens }, tools = null, dailyLimit = DEFAULT_DAILY_LIMIT, purpose = '', localRpm = DEFAULT_LOCAL_RPM, callOpts = {}) {
  const isLocal = /127\.0\.0\.1|localhost/i.test(baseUrl || '');
  const countUsage = callOpts.countUsage !== false;
  if (!isLocal) {
    if (countUsage) checkAndTrackCloudLimit(dailyLimit);
  } else {
    checkLocalRateLimit(baseUrl, localRpm, getActiveTrace()?.id ?? null);
  }

  const isAnthropic = (baseUrl || '').includes('anthropic.com');
  if (isAnthropic) {
    return callAnthropic(messages, { apiKey, model, maxTokens }, tools, purpose);
  }
  const url = (baseUrl || '').replace(/\/$/, '') + '/chat/completions';
  const isOpenAINew = (baseUrl || '').includes('openai.com') && openaiUsesMaxCompletionTokens(model);
  const isOpenAI = (baseUrl || '').includes('openai.com');
  const body = {
    model,
    messages,
    ...(isOpenAINew ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(isOpenAINew ? { reasoning_effort: 'none' } : {}),
    stream: false,
    ...(tools && tools.length > 0 ? { tools } : {}),
    // Passed through for provider-side observability only; not visible to the model.
    // OpenAI: `user` field. Local models silently ignore unknown top-level keys.
    ...(purpose && (isOpenAI || isLocal) ? { user: purpose } : {}),
  };
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey && apiKey !== 'not-needed' && { Authorization: `Bearer ${apiKey}` }),
  };
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

/**
 * @param {Array<{ role: 'system'|'user'|'assistant', content: string }>} messages
 * @returns {Promise<string>}
 */
export async function chat(messages, options = {}) {
  const { models, dailyLimit, localRpm } = loadConfig(options);
  const purpose = options.purpose || 'chat';
  const maxTokensOverride = Number(options.maxTokens);
  let lastError;
  let localError;
  for (const opts of models) {
    const callOpts = Number.isFinite(maxTokensOverride) && maxTokensOverride > 0
      ? { ...opts, maxTokens: maxTokensOverride }
      : opts;
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    const isLocal = /127\.0\.0\.1|localhost/i.test(opts.baseUrl || '');
    if (options.skipLocal && isLocal) continue;
    const llmCtx = beginLlmCall({ purpose, model: label, agentId: options.agentId });
    try {
      const content = await runModelWithRetries({
        label,
        isLocal,
        llmCtx,
        callFactory: ({ countUsage }) => callOne(messages, callOpts, null, dailyLimit, purpose, localRpm, { countUsage }),
        parseOkResponse: async (res) => {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (text == null) throw new Error('No content in LLM response');
          return { result: text.trim() };
        },
      });
      return content;
    } catch (err) {
      if (isLocalRateLimitError(err)) {
        console.log('[LLM] local rate limit reached, rejecting request:', err.message);
        throw err;
      }
      if (isDailyLimitFallbackError(err)) {
        console.log('[LLM] cloud daily limit reached, skipping:', label);
        lastError = err;
        continue;
      }
      if (isLocal) {
        console.log('[LLM] local model unreachable, trying cloud fallback:', err.message);
        localError = err;
      } else {
        console.log('[LLM] try failed:', label, summarizeLlmError(err?.message));
      }
      lastError = err;
    }
  }
  throw localError || lastError || new Error('No LLM configured');
}

/**
 * OpenAI-format tool: { type: "function", function: { name, description, parameters } }.
 * parameters is JSON Schema (e.g. { type: "object", properties: {...} }).
 *
 * @param {Array<{ role: string, content?: string, tool_calls?: Array<{ id: string, type: string, function: { name: string, arguments: string } }> }>} messages
 * @param {Array<{ type: 'function', function: { name: string, description: string, parameters: object } }>} tools - OpenAI tools array
 * @returns {Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }> }>}
 */
export async function chatWithTools(messages, tools, options = {}) {
  const { models, dailyLimit, localRpm } = loadConfig(options);
  const purpose = options.purpose || 'chat_with_tools';
  const toolCount = Array.isArray(tools) ? tools.length : 0;
  let lastError;
  let localError;
  for (const opts of models) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    const isLocal = /127\.0\.0\.1|localhost/i.test(opts.baseUrl || '');
    const llmCtx = beginLlmCall({ purpose, model: label, agentId: options.agentId, toolCount });
    try {
      return await runModelWithRetries({
        label,
        isLocal,
        llmCtx,
        toolCount,
        callFactory: ({ countUsage }) => callOne(messages, opts, tools, dailyLimit, purpose, localRpm, { countUsage }),
        parseOkResponse: async (res) => {
          const data = await res.json();
          const msg = data.choices?.[0]?.message;
          if (!msg) throw new Error('No message in LLM response');
          const content = (msg.content && String(msg.content).trim()) || '';
          const rawCalls = msg.tool_calls || [];
          const toolCalls = rawCalls.map((tc) => ({
            id: tc.id || '',
            name: tc.function?.name || '',
            arguments: typeof tc.function?.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function?.arguments || {}),
          }));
          return {
            result: { content, toolCalls },
            detail: { returnedToolCalls: toolCalls.length },
          };
        },
      });
    } catch (err) {
      if (isLocalRateLimitError(err)) {
        console.log('[LLM] local rate limit reached, rejecting request:', err.message);
        throw err;
      }
      if (isDailyLimitFallbackError(err)) {
        console.log('[LLM] cloud daily limit reached, skipping:', label);
        lastError = err;
        continue;
      }
      if (isLocal) {
        console.log('[LLM] local model unreachable, trying cloud fallback:', err.message);
        localError = err;
      } else {
        console.log('[LLM] try failed:', label, summarizeLlmError(err?.message));
      }
      lastError = err;
    }
  }
  throw localError || lastError || new Error('No LLM configured');
}

/**
 * Classify user intent for routing. Identify first, then we decide reply behaviour.
 * Uses one short LLM call.
 * @param {string} userMessage
 * @returns {Promise<'CHAT'|'SCHEDULE_LIST'|'SCHEDULE_CREATE'>}
 */
const INTENT_TIMEOUT_MS = 15_000;

export async function classifyIntent(userMessage, options = {}) {
  const messages = [
    {
      role: 'system',
      content: `You classify the user's intent. Reply with exactly one word: CHAT, SCHEDULE_LIST, SCHEDULE_CREATE, or SEARCH.

SEARCH = the user wants CURRENT, RECENT, or REAL-TIME information from the web. Any question about WEATHER (for any place, e.g. "how is enola weather", "weather in Tokyo", "what's the weather today") = SEARCH. Any question about current time, date, or live data = SEARCH. Other examples: "what's the time now", "current time", "is it sunny or rainy", "recent AI trends", "latest news about X", "what's trending today", "search for X", "current price of Y".

SCHEDULE_LIST = the user ONLY wants to see, list, count, or ask about existing scheduled jobs/reminders/crons. Examples: "do we have any crons?", "which crons are set?", "list my reminders", "what's scheduled?".

SCHEDULE_CREATE = the user wants to CREATE or SET a new reminder or schedule. Examples: "remind me in 5 minutes", "send me X tomorrow", "set a cron for 8am".

CHAT = greetings, general knowledge questions (that don't need current data), or conversation. Examples: "Hi", "what is the capital of France", "explain quantum computing".`,
    },
    { role: 'user', content: (userMessage || '').trim() || 'Hi' },
  ];
  const { models, dailyLimit, localRpm } = loadConfig(options);
  const purpose = options.purpose || 'classify_intent';
  let lastError;
  for (const opts of models) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    const isLocal = /127\.0\.0\.1|localhost/i.test(opts.baseUrl || '');
    const llmCtx = beginLlmCall({ purpose, model: label, agentId: options.agentId });
    try {
      const intent = await runModelWithRetries({
        label,
        isLocal,
        llmCtx,
        callFactory: ({ countUsage }) => Promise.race([
          callOne(messages, { ...opts, maxTokens: 25 }, null, dailyLimit, purpose, localRpm, { countUsage }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('intent timeout')), INTENT_TIMEOUT_MS)),
        ]),
        parseOkResponse: async (res) => {
          const data = await res.json();
          const content = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
          let intent = 'CHAT';
          if (content.includes('SCHEDULE_LIST')) intent = 'SCHEDULE_LIST';
          else if (content.includes('SCHEDULE_CREATE')) intent = 'SCHEDULE_CREATE';
          else if (content.includes('SCHEDULE')) intent = 'SCHEDULE_CREATE';
          else if (content.includes('SEARCH')) intent = 'SEARCH';
          const lower = (userMessage || '').trim().toLowerCase();
          if (intent === 'CHAT' && (/\bweather\b/.test(lower) || /\b(current )?time\b/.test(lower) || /\b(latest|recent|today'?s?) (news|headlines)\b/.test(lower))) {
            intent = 'SEARCH';
          }
          return { result: intent, detail: { intent } };
        },
      });
      return intent;
    } catch (err) {
      if (isLocalRateLimitError(err)) {
        console.log('[LLM] local rate limit reached, rejecting intent request:', err.message);
        throw err;
      }
      if (isDailyLimitFallbackError(err)) {
        console.log('[LLM] cloud daily limit reached, trying next model:', label);
        lastError = err;
        continue;
      }
      console.log('[LLM] intent try failed:', label, summarizeLlmError(err?.message));
      lastError = err;
    }
  }
  if (lastError) return 'CHAT';
  throw new Error('No LLM configured');
}

/**
 * Vision: describe or analyze an image using a vision-capable model.
 * - If the agent's current model already supports vision (e.g. GPT-4o, Claude-3), the image is sent to it
 *   with the same key; no extra key or switch.
 * - If the agent is on a text-only model (e.g. GPT-3.5, Llama-3) and all agent models fail, we quietly
 *   use the configured vision fallback (skills.vision.fallback or llm.vision) for that call only.
 *   Configure the fallback at setup; no mid-run prompts.
 * imageUrlOrDataUri: data URI or https URL. For file paths, convert to data URI in the caller.
 * @returns {Promise<string>}
 */
export async function describeImage(imageUrlOrDataUri, prompt, systemPrompt = 'You are a helpful vision assistant. Describe or analyze the image concisely.', options = {}) {
  const urlOrData = (imageUrlOrDataUri || '').trim();
  if (!urlOrData) throw new Error('describeImage requires image URL or data URI');

  const isDataUri = /^data:image\/[^;]+;base64,/.test(urlOrData);
  let userContentOpenAI;
  let userContentAnthropic;

  if (isDataUri) {
    const match = urlOrData.match(/^data:(image\/[^;]+);base64,(.+)$/);
    const mediaType = (match && match[1]) || 'image/jpeg';
    const base64 = (match && match[2]) || '';
    userContentOpenAI = [
      { type: 'text', text: prompt || 'What is in this image?' },
      { type: 'image_url', image_url: { url: urlOrData } },
    ];
    userContentAnthropic = [
      { type: 'text', text: prompt || 'What is in this image?' },
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
    ];
  } else {
    userContentOpenAI = [
      { type: 'text', text: prompt || 'What is in this image?' },
      { type: 'image_url', image_url: { url: urlOrData } },
    ];
    userContentAnthropic = null;
  }

  const messages = [{ role: 'user', content: userContentOpenAI }];
  const { models, visionFallback, dailyLimit } = loadConfig(options);
  const purpose = options.purpose || 'describe_image';
  const candidates = visionFallback ? [...models, visionFallback] : [...models];
  let lastError;
  for (const opts of candidates) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    const isAnthropic = (opts.baseUrl || '').includes('anthropic.com');
    if (isAnthropic && (!opts.apiKey || opts.apiKey === 'not-needed' || String(opts.apiKey || '').trim() === '')) continue;
    const isLocal = /127\.0\.0\.1|localhost/i.test(opts.baseUrl || '');
    const llmCtx = beginLlmCall({ purpose, model: label, agentId: options.agentId });
    try {
      let res;
      if (isAnthropic && userContentAnthropic) {
        if (!isLocal) checkAndTrackCloudLimit(dailyLimit);
        const body = {
          model: opts.model,
          max_tokens: opts.maxTokens || 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContentAnthropic }],
          ...(purpose ? { metadata: { user_id: purpose } } : {}),
        };
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': opts.apiKey || '',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
        });
      } else if (!isAnthropic) {
        const fullMessages = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : messages;
        res = await callOne(fullMessages, opts, null, dailyLimit, purpose);
      } else {
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Vision request failed ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data.content?.[0]?.text ?? data.choices?.[0]?.message?.content ?? '';
      if (text) {
        console.log('[LLM] vision used:', label);
        endLlmCall(llmCtx, { model: label, status: 'ok' });
        return String(text).trim();
      }
      throw new Error('No content in vision response');
    } catch (err) {
      endLlmCall(llmCtx, { model: label, status: 'error', message: err?.message || String(err) });
      if (isDailyLimitFallbackError(err)) {
        console.log('[LLM] cloud daily limit reached, trying next model:', label);
        lastError = err;
        continue;
      }
      const msg = (err && err.message) || '';
      const looksLikeTextOnly = /invalid.*content|does not support|400|image|vision|multimodal/i.test(msg);
      console.log('[LLM] vision try failed:', label, err.message);
      lastError = err;
      if (looksLikeTextOnly) continue;
    }
  }
  throw lastError || new Error('No vision-capable LLM responded');
}

/**
 * Image generation (OpenAI DALL·E). Requires config.skills.vision.imageGeneration.apiKey (env var name)
 * or an OpenAI key from skills.vision.fallback when provider is openai.
 * Saves image to uploads dir and returns { path, caption } for sending to chat.
 * @param {string} prompt - What to draw.
 * @param {{ size?: string, model?: string }} [opts] - Optional size (default 1024x1024), model (default dall-e-3).
 * @returns {Promise<{ path: string, caption: string }>}
 */
export async function generateImage(prompt, opts = {}) {
  const p = (prompt && String(prompt).trim()) || '';
  if (!p) throw new Error('generateImage requires a prompt');

  const config = (() => {
    try {
      const raw = readFileSync(resolveConfigPath(opts?.agentId), 'utf8');
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  })();

  const imageCfg = config.skills?.vision?.imageGeneration;
  let apiKey = null;
  if (imageCfg && imageCfg.apiKey) {
    apiKey = fromEnv(imageCfg.apiKey) || fromEnv('LLM_1_API_KEY');
  }
  if (!apiKey || apiKey === 'not-needed') {
    const fallback = config.skills?.vision?.fallback;
    if (fallback && String(fallback.provider || '').toLowerCase() === 'openai' && fallback.apiKey) {
      apiKey = fromEnv(fallback.apiKey) || fromEnv('LLM_1_API_KEY');
    }
  }
  if (!apiKey || String(apiKey).trim() === '') {
    throw new Error('Image generation needs an OpenAI API key. Set skills.vision.imageGeneration.apiKey (env var name) or use OpenAI as vision fallback and run setup.');
  }

  const size = opts.size || imageCfg?.size || '1024x1024';
  const model = opts.model || imageCfg?.model || 'dall-e-3';

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model,
      prompt: p,
      n: 1,
      size: model.startsWith('dall-e-3') ? size : (size === '1024x1792' || size === '1792x1024' ? '1024x1024' : size),
      response_format: 'b64_json',
      quality: 'standard',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image generation failed ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  const revised = data.data?.[0]?.revised_prompt;
  if (!b64) throw new Error('No image data in response');

  const uploadsDir = getUploadsDir();
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const path = join(uploadsDir, `generated-${Date.now()}.png`);
  const buf = Buffer.from(b64, 'base64');
  writeFileSync(path, buf);

  const caption = (revised && String(revised).trim()) ? String(revised).trim().slice(0, 500) : p.slice(0, 500);
  return { path, caption };
}

/** Return today's cloud LLM usage: { date, count, limit, localRpm }. */
export function getLlmUsageToday(options = {}) {
  const { dailyLimit, localRpm } = loadConfig(options);
  const usage = readUsage();
  return { date: usage.date, count: usage.count, limit: dailyLimit, localRpm };
}

export { loadConfig, PRESETS };
