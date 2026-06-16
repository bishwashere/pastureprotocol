/**
 * Pending Telegram replies when send failed (e.g. network lost). Flush when the user sends another message.
 */

import { sendLongText } from './telegram.js';
import { getErrorMessageForLog } from './user-error.js';

/** @type {Map<string, string[]>} chatId -> list of texts to send */
const pending = new Map();

/**
 * Queue a reply for a Telegram chat (e.g. send failed).
 * @param {string} chatId - Telegram chat id
 * @param {string} text - Message text to send later
 */
export function addPending(chatId, text) {
  if (chatId == null || text == null) return;
  const key = String(chatId);
  if (!pending.has(key)) pending.set(key, []);
  pending.get(key).push(text);
}

/**
 * Drop pending replies for a chat without sending. Use when the user sends a new
 * message so we don't send a previous reply as the answer to the new question.
 * @param {string} chatId - Telegram chat id
 * @returns {number} Number of dropped messages (for logging)
 */
export function clearPending(chatId) {
  if (chatId == null) return 0;
  const key = String(chatId);
  const list = pending.get(key);
  const n = list ? list.length : 0;
  pending.delete(key);
  return n;
}

/**
 * Send all pending replies for a chat and clear the queue.
 * Long messages are sent paginated (same as normal Telegram sends).
 * @param {string} chatId - Telegram chat id
 * @param {import('node-telegram-bot-api')} bot - Telegram bot instance
 */
export async function flushPending(chatId, bot) {
  if (chatId == null || !bot) return;
  const key = String(chatId);
  const list = pending.get(key);
  if (!list || list.length === 0) return;
  pending.delete(key);
  const numId = Number(chatId);
  if (Number.isNaN(numId)) return;
  for (const text of list) {
    try {
      await sendLongText(bot, numId, text);
    } catch (e) {
      console.error('[pending-telegram] flush failed:', getErrorMessageForLog(e));
      list.slice(list.indexOf(text)).forEach((t) => addPending(chatId, t));
      break;
    }
  }
}
