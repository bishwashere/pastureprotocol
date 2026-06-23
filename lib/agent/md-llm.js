/**
 * MD prompt runner — the substrate for prompt-driven decisions.
 *
 * Architectural rule (see AGENTS.md):
 *   Decisions about user intent, classification, planning, routing, and
 *   natural-language synthesis live in MD prompts and are evaluated by an
 *   LLM at runtime. JS does NOT branch on user text; it loads the MD,
 *   asks the LLM, and returns structured output to the caller.
 *
 * Use this module to author new decisions:
 *   1. Drop a prompt at lib/agent/templates/<name>.md
 *   2. Call runMdPrompt({ promptName: '<name>', user: { ... } })
 *   3. Get back parsed JSON (or null on failure — callers degrade gracefully).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chat as llmChat } from '../../llm.js';
import { stripThinking } from './agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, 'templates');

/** In-process cache so we read each MD prompt from disk at most once. */
const promptCache = new Map();

/**
 * @param {string} promptName Filename without extension (e.g. 'work-mode-classifier').
 * @returns {string} The MD file's contents, trimmed.
 */
export function loadPrompt(promptName) {
  const name = String(promptName || '').trim();
  if (!name) throw new Error('runMdPrompt: promptName required');
  if (promptCache.has(name)) return promptCache.get(name);
  const candidates = [
    join(TEMPLATES_DIR, `${name}.md`),
    join(TEMPLATES_DIR, `${name}-prompt.md`),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      promptCache.set(name, text);
      return text;
    }
  }
  throw new Error(
    `runMdPrompt: prompt not found for '${name}' (looked in lib/agent/templates/)`
  );
}

/**
 * Strip code fences and language tags from an LLM response so we can JSON.parse it.
 * The MD prompt asks the LLM for "JSON only", but models still occasionally wrap
 * the output in ```json ... ``` fences. We do NOT branch on user text here — we
 * branch on the *system's own LLM output*, which is allowed (see AGENTS.md).
 */
function unwrapFencedJson(raw) {
  const cleaned = stripThinking(String(raw || ''))
    .trim()
    .replace(/^```[a-z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
  return cleaned;
}

/**
 * Run an MD prompt and return parsed JSON.
 *
 * @param {object} opts
 * @param {string} opts.promptName - Name of the MD file under lib/agent/templates/ (without .md).
 * @param {object} [opts.user] - JSON payload appended as the user message. Stringified for the LLM.
 * @param {string} [opts.userText] - Convenience: a plain user string appended verbatim. If `user` is also supplied, both are concatenated.
 * @param {string} [opts.agentId] - Forwarded to the LLM client for per-agent routing/quotas.
 * @param {string} [opts.purpose] - Forwarded for telemetry. Defaults to `md_prompt:<name>`.
 * @param {function} [opts.llmChat] - Test seam: inject a custom chat function. Defaults to llm.js.
 * @returns {Promise<object | null>} Parsed JSON from the LLM, or null on any failure.
 */
export async function runMdPrompt({
  promptName,
  user = null,
  userText = '',
  agentId,
  purpose,
  llmChat: injectedLlmChat = null,
} = {}) {
  let systemPrompt;
  try {
    systemPrompt = loadPrompt(promptName);
  } catch (err) {
    console.log('[md-llm] cannot load prompt:', err.message);
    return null;
  }

  const userPieces = [];
  if (userText && String(userText).trim()) userPieces.push(String(userText).trim());
  if (user && typeof user === 'object') userPieces.push(JSON.stringify(user, null, 2));
  const userMessage = userPieces.join('\n\n');
  if (!userMessage) {
    console.log('[md-llm] no user payload supplied for prompt:', promptName);
    return null;
  }

  const chatFn = typeof injectedLlmChat === 'function' ? injectedLlmChat : llmChat;
  let raw;
  try {
    raw = await chatFn(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { agentId, purpose: purpose || `md_prompt:${promptName}` },
    );
  } catch (err) {
    console.log(`[md-llm] LLM call failed for ${promptName}:`, err?.message || err);
    return null;
  }

  const cleaned = unwrapFencedJson(raw);
  if (!cleaned) {
    console.log(`[md-llm] empty response for ${promptName}`);
    return null;
  }
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.log(
      `[md-llm] could not parse JSON from ${promptName}:`,
      err?.message || err,
      '— raw:',
      cleaned.slice(0, 200)
    );
    return null;
  }
}

/**
 * Test helper — clear the in-process prompt cache. Call from test setUp/tearDown.
 */
export function clearPromptCacheForTests() {
  promptCache.clear();
}
