/**
 * Track which Telegram user added the bot to each group.
 * Used so the bot only responds in groups where the adder is the configured bot owner.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { getStateDir } from './paths.js';

const FILENAME = 'telegram-group-added-by.json';

function getPath() {
  return `${getStateDir()}/${FILENAME}`;
}

function load() {
  try {
    const path = getPath();
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    if (!raw?.trim()) return {};
    const data = JSON.parse(raw);
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

function save(data) {
  const dir = getStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getPath(), JSON.stringify(data, null, 0), 'utf8');
}

/**
 * @param {string | number} chatId - Telegram group chat id (negative number).
 * @returns {number | null} Telegram user id who added the bot to this group, or null if unknown.
 */
export function getGroupAddedBy(chatId) {
  if (chatId == null) return null;
  const key = String(chatId).trim();
  if (!key) return null;
  const data = load();
  const val = data[key];
  if (val == null) return null;
  const n = typeof val === 'number' ? val : parseInt(String(val), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Record that the given user added the bot to the given group.
 * @param {string | number} chatId - Telegram group chat id.
 * @param {number} userId - Telegram user id of the person who added the bot.
 */
export function setGroupAddedBy(chatId, userId) {
  if (chatId == null || userId == null) return;
  const key = String(chatId).trim();
  if (!key) return;
  const n = typeof userId === 'number' ? userId : parseInt(String(userId), 10);
  if (!Number.isFinite(n)) return;
  const data = load();
  data[key] = n;
  save(data);
}
