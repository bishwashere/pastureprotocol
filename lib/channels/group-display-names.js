/**
 * Per-user preferred display names in group chat.
 * Each user can set only their own preferred name (e.g. "call me Bob"); other users cannot set it for them.
 * Stored in state dir; used when building "Message from [name] in the group" so the bot uses the preferred name.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { getStateDir } from './paths.js';

const FILENAME = 'group-display-names.json';

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
 * Storage key for a sender. Use when getting/setting so WhatsApp and Telegram use consistent keys.
 * @param {'whatsapp'|'telegram'} platform
 * @param {string} senderId - WhatsApp: full participant JID (e.g. 123@s.whatsapp.net); Telegram: String(msg.from.id)
 * @returns {string}
 */
export function displayNameKey(platform, senderId) {
  if (!senderId || String(senderId).trim() === '') return '';
  const id = String(senderId).trim().toLowerCase();
  return `${platform}:${id}`;
}

/**
 * Get the preferred display name for a group chat sender, if they set one.
 * @param {'whatsapp'|'telegram'} platform
 * @param {string} senderId - Participant JID (WhatsApp) or Telegram user id string
 * @returns {string|null} Preferred name or null
 */
export function getGroupDisplayName(platform, senderId) {
  const key = displayNameKey(platform, senderId);
  if (!key) return null;
  const data = load();
  const value = data[key];
  if (value == null || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Set the preferred display name for a sender. Only call this when the message author is setting their own name.
 * @param {'whatsapp'|'telegram'} platform
 * @param {string} senderId - Participant JID or Telegram user id
 * @param {string} name - Preferred display name (will be trimmed)
 */
export function setGroupDisplayName(platform, senderId, name) {
  const key = displayNameKey(platform, senderId);
  if (!key) return;
  const trimmed = typeof name === 'string' ? name.trim() : '';
  const data = load();
  if (trimmed === '') {
    delete data[key];
  } else {
    data[key] = trimmed;
  }
  save(data);
}

/** Match "call me X" or "/myname X" (only for the sender setting their own name). Returns trimmed name or null. */
const CALL_ME_RE = /^call\s+me\s+(.+)$/i;
const MYNAME_RE = /^\/myname\s+(.+)$/i;

/**
 * If the message is a request to set the sender's display name, return the requested name; otherwise null.
 * Used so we can intercept and save (only the sender can set their own name).
 * @param {string} text - Trimmed message text
 * @returns {string|null}
 */
export function parseSetDisplayNameMessage(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  let match = MYNAME_RE.exec(t);
  if (!match) match = CALL_ME_RE.exec(t);
  if (!match || !match[1]) return null;
  const name = match[1].trim();
  return name === '' ? null : name;
}
