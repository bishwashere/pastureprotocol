/**
 * Strip internal reply decorations before sending to the user.
 * Full tagged text should stay in daemon logs / team activity (upstream textToSend).
 */

const DELEGATION_PREFIX_RE =
  /^\[CowCode\]\s*(?:[^\n:]{1,80}?\s+)?replied:\s*(?:\[CowCode\]\s*)?/i;
const BARE_REPLIED_PREFIX_RE = /^(?:[a-z][\w.-]*\s+)?replied:\s*/i;
const COWCODE_LINE_RE = /(^|\n)\s*\[CowCode\]\s*/gi;

/**
 * @param {string} text
 * @returns {string}
 */
export function formatUserFacingReply(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  for (let i = 0; i < 6; i++) {
    const prev = s;
    s = s
      .replace(DELEGATION_PREFIX_RE, '')
      .replace(BARE_REPLIED_PREFIX_RE, '')
      .replace(/^\[CowCode\]\s*/i, '')
      .replace(COWCODE_LINE_RE, '$1')
      .trim();
    if (s === prev) break;
  }
  return s;
}

/**
 * Log tagged reply when it differs from what the user will see.
 * @param {string} raw
 * @param {string} userFacing
 * @param {{ channel?: string }} [opts]
 */
export function logOutboundReplyDecorations(raw, userFacing, opts = {}) {
  const r = String(raw || '').trim();
  const u = String(userFacing || '').trim();
  if (!r || r === u) return;
  const ch = opts.channel ? ` channel=${opts.channel}` : '';
  console.log(`[outbound]${ch} raw reply:`, r);
}
