/**
 * Strip internal reply decorations before sending to the user.
 * Full tagged text should stay in daemon logs / team activity (upstream textToSend).
 */

const SKILL_HEADER_NAMES = [
  'go-read',
  'go-write',
  'memory_search',
  'memory',
  'read',
  'browse',
  'github',
  'search',
  'agent-send',
  'vision',
  'cron',
];

/** True when the reply reads like a per-tool report instead of a user answer. */
export function looksLikeToolAuditReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (/what i found using|required tools|using the (?:required )?tools/i.test(lower)) return true;
  let headers = 0;
  for (const name of SKILL_HEADER_NAMES) {
    const re = new RegExp(`(^|\\n)\\s*${name.replace(/-/g, '[\\-]')}\\s*(\\n|$)`, 'i');
    if (re.test(raw)) headers += 1;
  }
  if (headers >= 2) return true;
  if (headers >= 1 && /pasture workspace|chat-log\/|memory\.md doesn/i.test(lower)) return true;
  return false;
}

const DELEGATION_PREFIX_RE =
  /^\[(?:CowCode|Pasture(?: Protocol)?)\]\s*(?:[^\n:]{1,80}?\s+)?replied:\s*(?:\[(?:CowCode|Pasture(?: Protocol)?)\]\s*)?/i;
const BARE_REPLIED_PREFIX_RE = /^(?:[a-z][\w.-]*\s+)?replied:\s*/i;
const PASTURE_LINE_RE = /(^|\n)\s*\[(?:CowCode|Pasture(?: Protocol)?)\]\s*/gi;

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
      .replace(/^\[(?:CowCode|Pasture(?: Protocol)?)\]\s*/i, '')
      .replace(PASTURE_LINE_RE, '$1')
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
