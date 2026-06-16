/**
 * Group-only guard: rate limiting and drastic-action approval for Telegram groups.
 * These checks run only when the chat is a group (not in one-on-one / private chats).
 */

/** Telegram: group and supergroup chats have negative chat.id; private chats have positive. */
const TG_GROUP_TYPES = new Set(['group', 'supergroup']);

/**
 * Only true for group/supergroup. Private chats return false — no guard logic there.
 * @param {{ type?: string, id?: number }} chat - msg.chat from Telegram
 * @returns {boolean}
 */
export function isTelegramGroup(chat) {
  if (!chat) return false;
  if (TG_GROUP_TYPES.has(chat.type)) return true;
  if (typeof chat.id === 'number' && chat.id < 0) return true;
  return false;
}

/** Cron/schedule/remind: not allowed for non-owners in groups (no approval path). */
const CRON_PATTERNS = [
  /\b(schedule|remind|set a reminder|cron|set cron)\b/i,
  /\b(remind me|send me .* (in|at|tomorrow))\b/i,
];

/** Scan (secrets, disk, directory, etc.): not allowed for non-owners in groups (no approval path). */
const SCAN_PATTERNS = [
  /\bscan\s+(for|my|the|this|your)\b/i,
  /\b(run|do|perform)\s+(a\s+)?scan\b/i,
  /\bscan\s+(machine|disk|directory|folder|files|secrets)\b/i,
  /\bscanning\s+(for|my|the)\b/i,
];

/** Patterns that suggest a "drastic" request: run commands, list/see files, edit files, browse, external services. Cron is handled separately (not allowed for non-owners). */
const DRASTIC_PATTERNS = [
  /\b(run|execute|shell|command line|terminal)\b.*\b(command|cmd|bash|sh)\b/i,
  /\b(run|execute)\s+(ls|cat|cd|rm|mv|cp|chmod|npm|node|python|git)\b/i,
  /\b(list|show|see)\s+(me\s+)?(the\s+)?(all\s+)?files?\b/i,
  /\b(list|show|see)\s+(the\s+)?(directory|contents|folder)\b/i,
  /\b(list\s+all\s+files|list\s+files|list\s+directory)\b/i,
  /\bwhat\s+files?\s+(are\s+)?(there|in)\b/i,
  /\b(show|list)\s+(me\s+)?(the\s+)?(file|folder)\s+list\b/i,
  /\b(edit|change|modify|patch)\s+(file|files|code|config)\b/i,
  /\b(write|create|save)\s+(file|files|to disk)\b/i,
  /\b(browse|open|navigate)\s+(to|the)\s+(web|url|site)\b/i,
  /\b(go to|navigate to)\s+https?:\/\//i,
  /\b(google|gmail|calendar)\b/i,
  /\b(apply patch|apply this patch)\b/i,
];

/**
 * True if the message is about creating or managing cron/schedule/reminders. Non-owners in groups are not allowed to use cron (blocked, no approval).
 * @param {string} text - User message
 * @returns {boolean}
 */
export function isCronIntent(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return CRON_PATTERNS.some((re) => re.test(t));
}

/**
 * True if the message is about scanning (secrets, disk, directory, etc.). Non-owners in groups are not allowed (blocked, no approval).
 * @param {string} text - User message
 * @returns {boolean}
 */
export function isScanIntent(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return SCAN_PATTERNS.some((re) => re.test(t));
}

/**
 * Heuristic: does the message likely ask for a high-impact action (run code, edit files, browse, etc.)?
 * Used only in groups to decide if we need bot owner approval before running the agent (owner = config, not group admin).
 * @param {string} text - User message
 * @returns {boolean}
 */
export function isDrasticIntent(text) {
  const t = (text || '').trim();
  if (!t) return false;
  return DRASTIC_PATTERNS.some((re) => re.test(t));
}

const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 5;

/** @type {Map<string, number[]>} key -> sorted timestamps of requests */
const rateBuckets = new Map();

function pruneOld(key) {
  const list = rateBuckets.get(key);
  if (!list) return;
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const kept = list.filter((ts) => ts > cutoff);
  if (kept.length === 0) rateBuckets.delete(key);
  else rateBuckets.set(key, kept);
}

/**
 * Rate limit: only meaningful in groups. Returns true if this (group) requester is over limit.
 * @param {string} key - e.g. `${chatId}:${fromId}`
 * @returns {boolean} true if over limit (should block and tell user to wait or ask bot owner)
 */
export function isOverRateLimit(key) {
  pruneOld(key);
  const list = rateBuckets.get(key) || [];
  return list.length >= RATE_MAX_REQUESTS;
}

/**
 * Record one request for rate limiting. Call only when we're about to run the agent (group, non-owner).
 * @param {string} key - same as for isOverRateLimit
 */
export function recordGroupRequest(key) {
  const list = rateBuckets.get(key) || [];
  list.push(Date.now());
  rateBuckets.set(key, list);
  pruneOld(key);
}

/** One pending approval per owner: { groupJid, groupTitle?, fromId, fromUsername?, fromName?, userMessage, createdAt } */
let pendingByOwnerId = null;

/**
 * Set pending approval request (group member asked something drastic). Only used when chat is a group.
 * @param {number} ownerTelegramId
 * @param {{ groupJid: string, groupTitle?: string, fromId: number, fromUsername?: string, fromName?: string, userMessage: string }} data
 */
export function setPendingApproval(ownerTelegramId, data) {
  pendingByOwnerId = { ownerId: ownerTelegramId, ...data, createdAt: Date.now() };
}

/**
 * @param {number} ownerTelegramId
 * @returns {{ groupJid: string, groupTitle?: string, fromId: number, fromUsername?: string, fromName?: string, userMessage: string } | null}
 */
export function getPendingApproval(ownerTelegramId) {
  if (!pendingByOwnerId || pendingByOwnerId.ownerId !== ownerTelegramId) return null;
  return pendingByOwnerId;
}

/** Clear pending after owner approves or denies. */
export function clearPendingApproval(ownerTelegramId) {
  if (pendingByOwnerId && pendingByOwnerId.ownerId === ownerTelegramId) pendingByOwnerId = null;
}

/** Last-seen timestamp per group member: key = `${groupJid}:${userId}`, value = ms */
const memberLastSeen = new Map();
const GREET_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * True if we should greet this group member: first time we see them, or not seen in the last hour.
 * @param {string} groupJid - Group chat id (e.g. Telegram chatId as string)
 * @param {number|string} userId - Sender's user id (e.g. msg.from.id)
 * @returns {boolean}
 */
export function shouldGreetMember(groupJid, userId) {
  if (groupJid == null || userId == null) return false;
  const key = `${String(groupJid)}:${String(userId)}`;
  const last = memberLastSeen.get(key);
  if (last == null) return true;
  return Date.now() - last > GREET_WINDOW_MS;
}

/**
 * Record that we just saw this member in the group (call after shouldGreetMember when processing their message).
 * @param {string} groupJid
 * @param {number|string} userId
 */
export function recordMemberSeen(groupJid, userId) {
  if (groupJid == null || userId == null) return;
  const key = `${String(groupJid)}:${String(userId)}`;
  memberLastSeen.set(key, Date.now());
}
