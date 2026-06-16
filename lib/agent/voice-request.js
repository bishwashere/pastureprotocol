/**
 * Detect when the user is asking for a voice reply (so the agent can reply with voice
 * even when the incoming message was text).
 */

const VOICE_REQUEST_PATTERNS = [
  /\breply\s+(in|with|by)\s+voice\b/i,
  /\bsend\s+(a\s+)?voice\s+(message|reply|response)\b/i,
  /\brespond\s+(with|in)\s+voice\b/i,
  /\bvoice\s+(message|reply|response)\s*(please)?\b/i,
  /\b(please\s+)?(send|reply)\s+voice\b/i,
  /\banswer\s+(in|with)\s+voice\b/i,
  /\b(respond|reply)\s+with\s+a\s+voice\b/i,
];

/**
 * True if the message text indicates the user wants a voice reply.
 * Used so the agent can reply with voice without requiring the user to send voice first.
 * @param {string} text - User message text
 * @returns {boolean}
 */
export function wantsVoiceReply(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  return VOICE_REQUEST_PATTERNS.some((re) => re.test(t));
}
