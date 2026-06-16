/**
 * Agent avatar generation and storage.
 *
 * Each agent can have a profile picture stored at:
 *   ~/.pasture/agents/<id>/avatar.png
 *
 * `generateAndSaveAgentAvatar()` calls DALL·E to create a small icon-style
 * avatar inspired by the agent's name/title, then writes it to the agent dir.
 * Subsequent calls are no-ops unless `force` is true, so generation only ever
 * runs once per agent.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getAgentDir, getAgentAvatarPath } from './paths.js';

/**
 * Build a prompt that reliably produces a small, distinct profile-picture for
 * the given agent title.  We want icon-style flat art without text so it reads
 * well at 48 px.
 * @param {string} title
 * @returns {string}
 */
function buildAvatarPrompt(title) {
  const name = String(title || 'agent').trim();
  return (
    `Extreme close-up face portrait of an AI persona named "${name}". ` +
    'Face and eyes fill the entire frame, forehead to chin, no neck or shoulders visible. ' +
    'Near-photorealistic, sharp focus on eyes, soft studio lighting, neutral dark background. ' +
    'No text, no body, no wide shot. Passport photo crop.'
  );
}

/**
 * Read the OpenAI API key from the agent config (same resolution as llm.js).
 * Returns null when none is found so callers can fail gracefully.
 * @param {string} agentId
 * @returns {string|null}
 */
function resolveOpenAiKey(agentId) {
  const fromEnv = (name) => {
    if (!name || typeof name !== 'string') return null;
    const v = process.env[name.trim()];
    return v && v.trim() && v.trim() !== 'not-needed' ? v.trim() : null;
  };

  try {
    const cfgPath = join(getAgentDir(agentId), 'config.json');
    const raw = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '{}';
    const cfg = JSON.parse(raw || '{}');

    // Prefer explicit imageGeneration key
    const imgKey = cfg.skills?.vision?.imageGeneration?.apiKey;
    if (imgKey) {
      const v = fromEnv(imgKey) || fromEnv('LLM_1_API_KEY');
      if (v) return v;
    }

    // Fall back to OpenAI vision fallback key
    const fb = cfg.skills?.vision?.fallback;
    if (fb && String(fb.provider || '').toLowerCase() === 'openai' && fb.apiKey) {
      const v = fromEnv(fb.apiKey) || fromEnv('LLM_1_API_KEY');
      if (v) return v;
    }
  } catch (_) {}

  // Last resort: well-known env var names
  return (
    fromEnv('LLM_1_API_KEY') ||
    fromEnv('OPENAI_API_KEY') ||
    null
  );
}

/**
 * Generate a profile picture for an agent using DALL·E 3 (256×256 via dall-e-2
 * to keep cost low) and save it to the agent directory.
 *
 * The function is intentionally quiet — it logs but never throws — so that
 * agent creation is never blocked by avatar failures.
 *
 * @param {string} agentId   - Agent id (directory key under agents/).
 * @param {string} [title]   - Human-readable title used in the prompt.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<string|null>}  Absolute path to the saved PNG, or null.
 */
export async function generateAndSaveAgentAvatar(agentId, title, opts = {}) {
  const id = String(agentId || '').trim();
  if (!id) return null;

  const avatarPath = getAgentAvatarPath(id);

  if (!opts.force && existsSync(avatarPath)) {
    return avatarPath;
  }

  const apiKey = resolveOpenAiKey(id);
  if (!apiKey) {
    console.warn(`[avatar] Skipping avatar for "${id}": no OpenAI API key found`);
    return null;
  }

  const label = String(title || id).trim();
  const prompt = buildAvatarPrompt(label);

  try {
    // gpt-image-1 (and newer OpenAI image APIs) dropped `response_format` in
    // favour of returning b64_json by default.  We omit the field entirely and
    // handle both b64_json and url response shapes.
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt,
        n: 1,
        size: '1024x1024',
        quality: 'low',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[avatar] Generation failed for "${id}" (${res.status}): ${text.slice(0, 200)}`);
      return null;
    }

    const data = await res.json();
    const item = data.data?.[0];

    // Resolve raw PNG bytes from either b64_json or url field.
    let buf;
    if (item?.b64_json) {
      buf = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
      const imgRes = await fetch(item.url);
      if (!imgRes.ok) {
        console.warn(`[avatar] Failed to download generated image for "${id}"`);
        return null;
      }
      buf = Buffer.from(await imgRes.arrayBuffer());
    } else {
      console.warn(`[avatar] No image data returned for "${id}"`);
      return null;
    }

    const agentDir = getAgentDir(id);
    if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });

    writeFileSync(avatarPath, buf);
    console.log(`[avatar] Saved avatar for "${id}" → ${avatarPath}`);
    return avatarPath;
  } catch (err) {
    console.warn(`[avatar] Error generating avatar for "${id}": ${err?.message || err}`);
    return null;
  }
}

/**
 * True when an avatar PNG already exists on disk for the given agent.
 * @param {string} agentId
 * @returns {boolean}
 */
export function hasAgentAvatar(agentId) {
  return existsSync(getAgentAvatarPath(String(agentId || '').trim()));
}
