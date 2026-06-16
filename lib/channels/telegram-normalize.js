/**
 * Normalize an incoming Telegram message to text (and optional replyWithVoice).
 * Handles photo (download → image path in text) and voice (download → transcribe).
 * Shared by private and group handlers.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * @param {import('node-telegram-bot-api').Message} msg
 * @param {{ bot: import('node-telegram-bot-api'), getChannelsConfig: () => { telegram: { botToken: string } }, getSpeechConfig: () => { whisperApiKey?: string } | null, getUploadsDir: () => string, transcribe: (apiKey: string, audioPath: string) => Promise<string> }} ctx
 * @returns {Promise<{ text: string, replyWithVoice: boolean }>}
 */
export async function normalizeTelegramMessage(msg, ctx) {
  const { bot, getChannelsConfig, getSpeechConfig, getUploadsDir, transcribe } = ctx;
  let text = (msg.text || '').trim();
  let replyWithVoice = false;
  const chatId = msg.chat?.id;

  if (!text && msg.photo && msg.photo.length > 0) {
    try {
      const photo = msg.photo[msg.photo.length - 1];
      const file = await bot.getFile(photo.file_id);
      const token = getChannelsConfig().telegram.botToken;
      const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const res = await fetch(downloadUrl);
      const buf = Buffer.from(await res.arrayBuffer());
      const uploadsDir = getUploadsDir();
      if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
      const imagePath = join(uploadsDir, `tg-${chatId}-${msg.message_id}.jpg`);
      writeFileSync(imagePath, buf);
      const caption = (msg.caption || '').trim();
      text = `User sent an image. Image file: ${imagePath}. ${caption ? 'Caption: ' + caption : "What's in this image?"}`;
    } catch (err) {
      console.error('[telegram] image download failed:', err.message);
      return { text: '', replyWithVoice: false };
    }
  }

  if (!text && msg.voice) {
    try {
      const speechConfig = getSpeechConfig();
      if (speechConfig?.whisperApiKey) {
        const file = await bot.getFile(msg.voice.file_id);
        const token = getChannelsConfig().telegram.botToken;
        const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const res = await fetch(downloadUrl);
        const buf = Buffer.from(await res.arrayBuffer());
        const uploadsDir = getUploadsDir();
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
        const audioPath = join(uploadsDir, `tg-voice-${chatId}-${msg.message_id}.ogg`);
        writeFileSync(audioPath, buf);
        text = await transcribe(speechConfig.whisperApiKey, audioPath);
        if (text && text.trim()) replyWithVoice = true;
      }
    } catch (err) {
      console.error('[telegram] voice transcribe failed:', err.message);
    }
  }

  return { text: text || '', replyWithVoice };
}
