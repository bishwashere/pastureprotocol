/**
 * WhatsApp-specific helpers (JID types, etc.).
 * Group chats use JIDs ending in @g.us.
 */

/**
 * True if jid is a WhatsApp group (e.g. 123456789@g.us).
 * @param {string | null | undefined} jid
 * @returns {boolean}
 */
export function isWhatsAppGroupJid(jid) {
  if (jid == null) return false;
  return String(jid).trim().endsWith('@g.us');
}
