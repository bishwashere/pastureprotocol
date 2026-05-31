/**
 * Shared instructions for user-facing replies (chat, delegation, dashboard).
 */

export const USER_REPLY_STYLE_LINES = [
  'Lead with a clear answer: what it is, what you found, and what you recommend next.',
  'Write one coherent narrative — not a numbered audit of each tool (GitHub / memory / filesystem / browse).',
  'If a tool failed, was unavailable, or returned nothing: omit it, or mention once briefly at the end under **Sources** — never open with failures.',
  'Do not say you "investigated end-to-end" unless you actually have substantive findings; say what you based the answer on.',
  'Never contradict yourself (e.g. "GitHub failed" in section 1 and "here is the full picture" in section 3).',
  'Skip empty results (no memory hits, empty MEMORY.md) unless the user asked specifically about memory.',
];

/**
 * System-prompt block appended to every one-on-one agent turn.
 * @returns {string}
 */
export function buildUserReplyStyleBlock() {
  return (
    '\n\n# Replying to the user\n' +
    USER_REPLY_STYLE_LINES.map((line) => `- ${line}`).join('\n')
  );
}
