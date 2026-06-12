/**
 * Configurable LLM client. All config values are read from .env (keys in config.json
 * are env var names). Supports preset providers and multiple models with priority.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getConfigPath, getUploadsDir, getAgentConfigPath, getLlmUsagePath } from './lib/paths.js';
import { DEFAULT_AGENT_ID } from './lib/agent-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Daily cloud LLM rate limiter
// Only cloud (non-local) calls count. Local models (ollama/lmstudio on 127.x)
// are free and never blocked. Counter resets at midnight UTC.
// Override the cap via config.json: { "llm": { "dailyLimit": 200 } }
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_LIMIT = 100;

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
 * Check and increment the daily cloud LLM counter.
 * Throws a non-retryable error with code 'LLM_DAILY_LIMIT' if the cap is reached.
 */
function checkAndTrackCloudLimit(dailyLimit = DEFAULT_DAILY_LIMIT) {
  const limit = Number(dailyLimit) > 0 ? Number(dailyLimit) : DEFAULT_DAILY_LIMIT;
  const usage = readUsage();
  if (usage.count >= limit) {
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
  const defaultMaxTokens = Number(fromEnv(llm.maxTokens)) || 100;

  if (Array.isArray(llm.models) && llm.models.length > 0) {
    let models = llm.models.map((entry, i) => {
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
      const priority = entry.priority === true || entry.priority === 1 ||
        String(entry.priority).toLowerCase() === 'true' || entry.priority === '1';
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
    return { models, maxTokens: defaultMaxTokens, visionFallback, dailyLimit };
  }

  const baseUrl = fromEnv('LLM_BASE_URL') || fromEnv(llm.baseUrl);
  const apiKey = fromEnv('LLM_API_KEY') ?? fromEnv(llm.apiKey);
  const model = fromEnv('LLM_MODEL') || fromEnv(llm.model);
  const maxTokens = Number(fromEnv(llm.maxTokens)) || 2048;
  const visionFallback = parseVisionFallback(config);
  const dailyLimit = Number(fromEnv(llm.dailyLimit)) || DEFAULT_DAILY_LIMIT;
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
  };
}

/** Call Anthropic Messages API and return a Response-like with OpenAI-shaped JSON. */
async function callAnthropic(messages, { apiKey, model, maxTokens }, tools) {
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

function callOne(messages, { baseUrl, apiKey, model, maxTokens }, tools = null, dailyLimit = DEFAULT_DAILY_LIMIT) {
  const isLocal = /127\.0\.0\.1|localhost/i.test(baseUrl || '');
  if (!isLocal) checkAndTrackCloudLimit(dailyLimit);

  const isAnthropic = (baseUrl || '').includes('anthropic.com');
  if (isAnthropic) {
    return callAnthropic(messages, { apiKey, model, maxTokens }, tools);
  }
  const url = (baseUrl || '').replace(/\/$/, '') + '/chat/completions';
  const isOpenAINew = (baseUrl || '').includes('openai.com') && openaiUsesMaxCompletionTokens(model);
  const body = {
    model,
    messages,
    ...(isOpenAINew ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(isOpenAINew ? { reasoning_effort: 'none' } : {}),
    stream: false,
    ...(tools && tools.length > 0 ? { tools } : {}),
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
  const { models, dailyLimit } = loadConfig(options);
  let lastError;
  for (const opts of models) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    try {
      const res = await callOne(messages, opts, null, dailyLimit);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM request failed ${res.status}: ${text}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content == null) throw new Error('No content in LLM response');
      console.log('[LLM] used:', label);
      return content.trim();
    } catch (err) {
      if (err.code === 'LLM_DAILY_LIMIT') throw err;
      console.log('[LLM] try failed:', label, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error('No LLM configured');
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
  const { models, dailyLimit } = loadConfig(options);
  let lastError;
  for (const opts of models) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    try {
      const res = await callOne(messages, opts, tools, dailyLimit);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM request failed ${res.status}: ${text}`);
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error('No message in LLM response');
      const content = (msg.content && String(msg.content).trim()) || '';
      const rawCalls = msg.tool_calls || [];
      const toolCalls = rawCalls.map((tc) => ({
        id: tc.id || '',
        name: tc.function?.name || '',
        arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
      }));
      console.log('[LLM] used:', label, toolCalls.length ? '(with tools)' : '');
      return { content, toolCalls };
    } catch (err) {
      if (err.code === 'LLM_DAILY_LIMIT') throw err;
      console.log('[LLM] try failed:', label, err.message);
      lastError = err;
    }
  }
  throw lastError || new Error('No LLM configured');
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
  const { models, dailyLimit } = loadConfig(options);
  let lastError;
  for (const opts of models) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    try {
      const res = await Promise.race([
        callOne(messages, { ...opts, maxTokens: 25 }, null, dailyLimit),
        new Promise((_, reject) => setTimeout(() => reject(new Error('intent timeout')), INTENT_TIMEOUT_MS)),
      ]);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM request failed ${res.status}: ${text}`);
      }
      const data = await res.json();
      const content = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
      let intent = 'CHAT';
      if (content.includes('SCHEDULE_LIST')) intent = 'SCHEDULE_LIST';
      else if (content.includes('SCHEDULE_CREATE')) intent = 'SCHEDULE_CREATE';
      else if (content.includes('SCHEDULE')) intent = 'SCHEDULE_CREATE';
      else if (content.includes('SEARCH')) intent = 'SEARCH';
      // Fallback: if user clearly asked about weather/time/news and model said CHAT, force SEARCH
      const lower = (userMessage || '').trim().toLowerCase();
      if (intent === 'CHAT' && (/\bweather\b/.test(lower) || /\b(current )?time\b/.test(lower) || /\b(latest|recent|today'?s?) (news|headlines)\b/.test(lower))) {
        intent = 'SEARCH';
      }
      return intent;
    } catch (err) {
      if (err.code === 'LLM_DAILY_LIMIT') throw err;
      console.log('[LLM] intent try failed:', label, err.message);
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
  const candidates = visionFallback ? [...models, visionFallback] : [...models];
  let lastError;
  for (const opts of candidates) {
    const label = opts.model || opts.baseUrl?.replace(/^https?:\/\//, '').slice(0, 20) || 'unknown';
    const isAnthropic = (opts.baseUrl || '').includes('anthropic.com');
    if (isAnthropic && (!opts.apiKey || opts.apiKey === 'not-needed' || String(opts.apiKey || '').trim() === '')) continue;
    const isLocal = /127\.0\.0\.1|localhost/i.test(opts.baseUrl || '');
    try {
      let res;
      if (isAnthropic && userContentAnthropic) {
        if (!isLocal) checkAndTrackCloudLimit(dailyLimit);
        const body = {
          model: opts.model,
          max_tokens: opts.maxTokens || 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContentAnthropic }],
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
        res = await callOne(fullMessages, opts, null, dailyLimit);
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
        return String(text).trim();
      }
      throw new Error('No content in vision response');
    } catch (err) {
      if (err.code === 'LLM_DAILY_LIMIT') throw err;
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

/** Return today's cloud LLM usage: { date, count, limit }. */
export function getLlmUsageToday(options = {}) {
  const { dailyLimit } = loadConfig(options);
  const usage = readUsage();
  return { date: usage.date, count: usage.count, limit: dailyLimit };
}

export { loadConfig, PRESETS };
