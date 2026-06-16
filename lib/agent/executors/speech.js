/**
 * Speech executor: Whisper (voice → text) and 11Labs (text → voice).
 * Config: skills.speech.whisper.apiKey (env var name), skills.speech.elevenLabs.apiKey, skills.speech.elevenLabs.voiceId (optional default).
 */

import { existsSync } from 'fs';
import { getSpeechConfig, transcribe, synthesizeToBuffer } from '../../integrations/speech-client.js';

/**
 * @param {object} ctx - unused
 * @param {object} args - action/command, audio, text, model, language, voiceId, outputPath
 * @returns {Promise<string>}
 */
export async function executeSpeech(ctx, args) {
  const action = (args?.action || args?.command || '').toString().toLowerCase().trim() || 'transcribe';
  const config = getSpeechConfig();

  if (action === 'transcribe') {
    const audioPath = args?.audio != null ? String(args.audio).trim() : '';
    if (!audioPath) throw new Error('speech transcribe requires "audio" (path to audio file).');
    if (!existsSync(audioPath)) throw new Error(`Audio file not found: ${audioPath}`);
    const key = config?.whisperApiKey;
    if (!key) throw new Error('Speech (Whisper) is not configured. Run pasture setup and set Whisper/OpenAI key.');
    const model = (args?.model && String(args.model).trim()) || 'whisper-1';
    const language = args?.language != null ? String(args.language).trim() : undefined;
    const text = await transcribe(key, audioPath, model, language);
    return JSON.stringify({ text });
  }

  if (action === 'synthesize') {
    const text = args?.text != null ? String(args.text).trim() : '';
    if (!text) throw new Error('speech synthesize requires "text".');
    const key = config?.elevenLabsApiKey;
    if (!key) throw new Error('Speech (11Labs) is not configured. Run pasture setup and set 11Labs API key.');
    const voiceId = (args?.voiceId && String(args.voiceId).trim()) || config?.defaultVoiceId || '21m00Tcm4TlvDq8ikWAM';
    const outputPath = args?.outputPath != null ? String(args.outputPath).trim() : undefined;
    const buf = await synthesizeToBuffer(key, text, voiceId, outputPath);
    if (outputPath) {
      return JSON.stringify({ path: outputPath, bytes: buf.length });
    }
    return JSON.stringify({ base64: buf.toString('base64'), bytes: buf.length, format: 'audio/mpeg' });
  }

  if (action === 'reply_as_voice') {
    const text = args?.text != null ? String(args.text).trim() : '';
    if (!text) throw new Error('speech reply_as_voice requires "text".');
    return JSON.stringify({ message: 'Reply will be sent as a voice message.' });
  }

  throw new Error(`Unknown speech action: ${action}. Use transcribe, synthesize, or reply_as_voice.`);
}
