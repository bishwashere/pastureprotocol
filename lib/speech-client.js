/**
 * Shared speech helpers: transcribe (Whisper) and synthesize (11Labs).
 * Used by the speech executor and by index.js for automatic voice-in → LLM → voice-out.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getConfigPath } from './paths.js';
import { getOpenAIKey } from './memory-config.js';

function fromEnv(val) {
  if (val == null || val === '') return undefined;
  const s = String(val).trim();
  return process.env[s] !== undefined ? process.env[s] : undefined;
}

export function getSpeechConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const speech = config.skills?.speech && typeof config.skills.speech === 'object' ? config.skills.speech : null;
    const whisperKey = speech?.whisper?.apiKey ? fromEnv(speech.whisper.apiKey) : undefined;
    const whisperApiKey = whisperKey || getOpenAIKey(config) || undefined;
    if (!whisperApiKey && !speech) return null;
    const elevenLabsKey = speech?.elevenLabs?.apiKey ? fromEnv(speech.elevenLabs.apiKey) : undefined;
    const defaultVoiceId = (speech?.elevenLabs?.voiceId && String(speech.elevenLabs.voiceId).trim()) || '21m00Tcm4TlvDq8ikWAM';
    return {
      whisperApiKey,
      elevenLabsApiKey: elevenLabsKey,
      defaultVoiceId,
    };
  } catch {
    return null;
  }
}

/**
 * Transcribe audio file via OpenAI Whisper API.
 * @param {string} apiKey
 * @param {string} audioPath
 * @param {string} [model]
 * @param {string} [language]
 * @returns {Promise<string>}
 */
export async function transcribe(apiKey, audioPath, model = 'whisper-1', language) {
  const fileBuffer = readFileSync(audioPath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), audioPath.split(/[/\\]/).pop() || 'audio');
  form.append('model', model);
  if (language && language.trim()) form.append('language', language.trim());

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Whisper API error ${res.status}: ${t || res.statusText}`);
  }
  const raw = await res.text();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === 'string') return parsed.text.trim();
  } catch (_) {}
  return raw.trim();
}

/**
 * Synthesize text to speech via 11Labs; return audio buffer (mp3).
 * @param {string} apiKey
 * @param {string} text
 * @param {string} [voiceId]
 * @param {string} [outputPath] - if set, write file and return buffer anyway
 * @returns {Promise<Buffer>}
 */
export async function synthesizeToBuffer(apiKey, text, voiceId = '21m00Tcm4TlvDq8ikWAM', outputPath) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: String(text).trim(),
      model_id: 'eleven_monolingual_v1',
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`11Labs API error ${res.status}: ${t || res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (outputPath) {
    const dir = dirname(outputPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, buf);
  }
  return buf;
}
