/**
 * User-facing reply style — injected once per chat/delegation turn, not in SOUL.md or goal/project blocks.
 */

export const USER_REPLY_STYLE_LINES = [
  'Lead with a clear answer: what it is, what you found, and what you recommend next.',
  'Write one coherent narrative — not a numbered audit of each tool (GitHub / memory / filesystem / browse).',
  'If a tool failed, was unavailable, or returned nothing: omit it, or mention once briefly at the end under **Sources** — never open with failures.',
  'Do not say you "investigated end-to-end" unless you actually have substantive findings; say what you based the answer on.',
  'Never contradict yourself (e.g. "GitHub failed" in section 1 and "here is the full picture" in section 3).',
  'Skip empty results (no memory hits, empty MEMORY.md) unless the user asked specifically about memory.',
];

const REPLY_SECTION_TITLE = '# Replying to the user';

/** @returns {string} */
export function buildUserReplyStyleBlock() {
  return (
    '\n\n' + REPLY_SECTION_TITLE + '\n' +
    USER_REPLY_STYLE_LINES.map((line) => `- ${line}`).join('\n')
  );
}

/** One choke point: append reply-style block for turns that reach the user (chat, dashboard, agent-send). */
export function appendUserFacingPrompt(systemPrompt = '') {
  const base = String(systemPrompt || '');
  if (base.includes(REPLY_SECTION_TITLE)) return base;
  return base + buildUserReplyStyleBlock();
}

/** Single line for the post-turn completeness probe (not duplicated in goals/projects). */
export const INCOHERENT_ANSWER_PROBE_HINT =
  '- Mark incomplete if the answer is incoherent: it opens with failures or empty checks but also claims a full investigation, or is mostly a tool audit without a clear summary.\n';
