/**
 * Bot owner config: who is the single super-admin of this Pasture install.
 * One physical machine == one human owner. Their conversations across all
 * surfaces (Telegram DM, WhatsApp DM, dashboard chat, cron messages targeted
 * at them) share ONE chat log file and ONE memory index, keyed by a stable
 * unified "log jid" (default: "owner").
 *
 * Routing (which channel a reply is sent to) still uses the per-channel id
 * — only the storage / memory key is unified.
 *
 * Group chats and DMs from non-owners are unchanged.
 */

import { readFileSync, existsSync } from 'fs';
import { getConfigPath } from './paths.js';

const DEFAULT_OWNER_LOG_JID = 'owner';

/**
 * Read the `owner` block from config.json.
 * Shape:
 *   {
 *     telegramUserId?: number,   // Telegram chat id of the owner's DM with the bot
 *     whatsappJid?: string,      // WhatsApp jid of the owner's DM with the bot
 *     logJid?: string            // Unified chat-log/memory key (default "owner")
 *   }
 * @returns {{ telegramUserId?: number, whatsappJid?: string, logJid?: string }}
 */
export function getOwnerConfig() {
  try {
    const path = getConfigPath();
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    if (!raw?.trim()) return {};
    const config = JSON.parse(raw);
    const owner = config.owner;
    if (!owner || typeof owner !== 'object') return {};
    const out = {};
    if (owner.telegramUserId != null) {
      const n = typeof owner.telegramUserId === 'number'
        ? owner.telegramUserId
        : parseInt(String(owner.telegramUserId), 10);
      if (Number.isFinite(n)) out.telegramUserId = n;
    }
    if (typeof owner.whatsappJid === 'string' && owner.whatsappJid.trim()) {
      out.whatsappJid = owner.whatsappJid.trim();
    }
    if (typeof owner.logJid === 'string' && owner.logJid.trim()) {
      out.logJid = owner.logJid.trim();
    }
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * @param {number|string} telegramUserId
 * @returns {boolean} True if this Telegram user id is the configured bot owner.
 *   Used to gate drastic actions (config edits, agent shutdown, permission changes)
 *   in groups and DMs — never derived from group admin/creator role.
 */
export function isOwner(telegramUserId) {
  if (telegramUserId == null) return false;
  const owner = getOwnerConfig();
  if (owner.telegramUserId == null) return false;
  return owner.telegramUserId === Number(telegramUserId);
}

/**
 * The unified chat-log / memory key for the owner.
 * @returns {string}
 */
export function getOwnerLogJid() {
  const owner = getOwnerConfig();
  return owner.logJid || DEFAULT_OWNER_LOG_JID;
}

/**
 * Does this runtime jid belong to the single owner across any surface?
 * - Literal owner log jid (e.g. "owner") — used by the dashboard chat.
 * - Owner's Telegram chat id — when Telegram DM is from the owner.
 * - Owner's WhatsApp jid — when WhatsApp DM is from the owner.
 *
 * Group jids are NEVER treated as owner jids here, even if the owner is in the
 * group: groups have their own log file and shared context with multiple people.
 *
 * @param {string|number|null|undefined} runtimeJid
 * @returns {boolean}
 */
export function isOwnerRuntimeJid(runtimeJid) {
  if (runtimeJid == null) return false;
  const s = String(runtimeJid).trim();
  if (!s) return false;
  const owner = getOwnerConfig();
  const ownerLogJid = owner.logJid || DEFAULT_OWNER_LOG_JID;
  if (s === ownerLogJid) return true;
  if (owner.telegramUserId != null && s === String(owner.telegramUserId)) return true;
  if (owner.whatsappJid && s === owner.whatsappJid) return true;
  return false;
}

/**
 * Map a runtime jid to the jid used for chat-log and memory storage.
 * - Owner jids (any surface) collapse to getOwnerLogJid() — one shared log.
 * - All other jids (other people's DMs, etc.) pass through unchanged so they
 *   keep their own per-jid log files.
 *
 * Group jids should NOT be passed through this — they use group-chat-log/<id>/.
 *
 * @param {string|number|null|undefined} runtimeJid
 * @returns {string|null} Log jid, or null if input was empty.
 */
export function toLogJid(runtimeJid) {
  if (runtimeJid == null) return null;
  const s = String(runtimeJid).trim();
  if (!s) return null;
  if (isOwnerRuntimeJid(s)) return getOwnerLogJid();
  return s;
}
