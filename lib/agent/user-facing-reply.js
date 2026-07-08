/**
 * Strip internal reply decorations before sending to the user.
 * Full tagged text should stay in daemon logs / team activity (upstream textToSend).
 */

const DELEGATION_PREFIX_RE =
  /^\[(?:Pasture|Pasture(?: Protocol)?)\]\s*(?:[^\n:]{1,80}?\s+)?replied:\s*(?:\[(?:Pasture|Pasture(?: Protocol)?)\]\s*)?/i;
const BARE_REPLIED_PREFIX_RE = /^(?:[a-z][\w.-]*\s+)?replied:\s*/i;
const PASTURE_LINE_RE = /(^|\n)\s*\[(?:Pasture|Pasture(?: Protocol)?)\]\s*/gi;
/** Model sometimes emits fake skill XML instead of calling run_skill — not human-readable. */
const FAKE_SKILL_TAG_RE = /<skill\s+action=["']([^"']+)["']\s+data=["']([\s\S]*?)["']\s*\/?>/gi;
/** Model sometimes emits fake JSON-shaped tool calls instead of plain text. */
const FAKE_TOOL_JSON_RE = /^\s*(?:```(?:json)?\s*)?\{\s*"(?:tool_uses|recipient_name|tool|name|function)"\s*:/i;

const INTERNAL_TOOL_KEY_RE =
  /"(?:tool_uses|recipient_name|tool_call_id|tool_calls)"\s*:|"(?:apply_patch_apply|run_skill)"|functions\.[a-z0-9_.-]+|\*\*\*\s*Begin Patch/i;

/**
 * True when the reply is fake skill/tool markup rather than plain human text.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeFakeSkillMarkup(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  FAKE_SKILL_TAG_RE.lastIndex = 0;
  return FAKE_SKILL_TAG_RE.test(s);
}

function unwrapFence(text) {
  const s = String(text || '').trim();
  const match = s.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : s;
}

function hasInternalToolShape(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value.tool_uses)) return true;
  if (typeof value.recipient_name === 'string') return true;
  if (Array.isArray(value.tool_calls)) return true;
  if (typeof value.tool_call_id === 'string') return true;
  if (typeof value.name === 'string' && value.parameters && typeof value.parameters === 'object') return true;
  if (value.function && typeof value.function === 'object' && typeof value.function.name === 'string') return true;
  return false;
}

/**
 * True when text is an internal tool invocation / patch payload rather than a
 * human reply. This checks artifact shape, not user intent.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeInternalToolArtifact(text) {
  const s = unwrapFence(formatPrefixOnly(String(text || '').trim()));
  if (!s) return false;
  if (INTERNAL_TOOL_KEY_RE.test(s)) return true;
  if (!FAKE_TOOL_JSON_RE.test(s)) return false;
  try {
    return hasInternalToolShape(JSON.parse(s));
  } catch (_) {
    return true;
  }
}

function formatPrefixOnly(text) {
  return String(text || '').replace(/^\[(?:Pasture|Pasture(?: Protocol)?)\]\s*/i, '').trim();
}

/**
 * Extract spoken/text payload from a fake <skill action="…" data="…"/> tag.
 * @param {string} dataRaw
 * @returns {string}
 */
function humanTextFromSkillData(dataRaw) {
  if (!dataRaw) return '';
  try {
    const jsonStr = String(dataRaw).replace(/\\"/g, '"');
    const data = JSON.parse(jsonStr);
    if (data && typeof data.text === 'string' && data.text.trim()) {
      return data.text.trim();
    }
  } catch (_) {}
  return '';
}

/**
 * Replace fake skill XML with the human text embedded in data.text (if any).
 * @param {string} text
 * @returns {string}
 */
export function unwrapFakeSkillMarkup(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  FAKE_SKILL_TAG_RE.lastIndex = 0;
  if (!FAKE_SKILL_TAG_RE.test(s)) return s;
  FAKE_SKILL_TAG_RE.lastIndex = 0;
  s = s.replace(FAKE_SKILL_TAG_RE, (_full, _action, dataRaw) => humanTextFromSkillData(dataRaw)).trim();
  return s;
}

/**
 * Drop a leading fake tool-call JSON object while preserving any human answer
 * that follows it.
 * @param {string} text
 * @returns {string}
 */
export function stripLeadingFakeToolJson(text) {
  const s = unwrapFence(String(text || '').trim());
  if (!FAKE_TOOL_JSON_RE.test(s)) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const rest = s.slice(i + 1).trim().replace(/^```\s*/, '').trim();
        return rest || '';
      }
    }
  }
  return s;
}

/**
 * Normalize reply text for the user: human-readable only (no tags, wrappers, or fake skill markup).
 * @param {string} text
 * @returns {string}
 */
export function formatUserFacingReply(text) {
  let s = stripLeadingFakeToolJson(unwrapFakeSkillMarkup(text));
  if (!s) return '';
  if (looksLikeInternalToolArtifact(s)) return '';
  for (let i = 0; i < 6; i++) {
    const prev = s;
    s = s
      .replace(DELEGATION_PREFIX_RE, '')
      .replace(BARE_REPLIED_PREFIX_RE, '')
      .replace(/^\[(?:Pasture|Pasture(?: Protocol)?)\]\s*/i, '')
      .replace(PASTURE_LINE_RE, '$1')
      .trim();
    if (s === prev) break;
  }
  if (looksLikeInternalToolArtifact(s)) return '';
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
  if (looksLikeInternalToolArtifact(r)) {
    console.log(`[outbound]${ch} raw reply suppressed:`, JSON.stringify({
      reason: 'internal_tool_artifact',
      rawLength: r.length,
      userFacingLength: u.length,
      sanitizedToEmpty: !u,
    }));
    return;
  }
  console.log(`[outbound]${ch} raw reply:`, r);
}
