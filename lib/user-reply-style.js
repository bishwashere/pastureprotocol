/**
 * User-facing reply style — injected once per chat/delegation turn, not in SOUL.md or goal/project blocks.
 */

export const USER_REPLY_STYLE_LINES = [
  'Lead with a clear answer: what it is, what you found, and what you recommend next.',
  'Write one coherent narrative — never a "What I found using tools" section or headings named after skills (go-read, read, memory, browse, github, search).',
  'Do not name tools, skills, or internal steps in the user-visible reply unless something is blocked and the user must act (one short sentence max).',
  'If something failed or was empty: omit it, or one brief note at the end — never open with failures or empty MEMORY.md / workspace listings.',
  'Do not say you "investigated end-to-end" unless you have substantive findings; never list the CowCode workspace folder contents unless the user asked where files are.',
  'Never contradict yourself (e.g. "no repo here" then a full product description without explaining the source).',
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
  '- Mark incomplete if the answer is incoherent: it opens with failures or empty checks but also claims a full investigation, or is mostly a tool audit without a clear summary.\n' +
  '- Mark incomplete if the reply lists skills/tools by name (go-read, memory, read) as sections or says "using the required tools".\n';

/** Internal retry user message when the model produced a tool-by-tool report. */
export function buildToolAuditRewriteInstruction(userText) {
  const q = String(userText || '').trim().slice(0, 500);
  return (
    `[Rewrite for user] The user asked: "${q}". ` +
    'Reply in plain language only: what the thing is, the important facts, and one optional sentence on gaps or next step. ' +
    'Do not name tools or skills. Do not use per-tool headings.'
  );
}
