/**
 * Shared E2E judge: a separate LLM call to decide whether the user got what they wanted.
 * See E2E.md for the testing model (we test the project's skill, not APIs/tokens).
 *
 * Usage:
 *   const { judgeUserGotWhatTheyWanted } = await import('./e2e-judge.js');
 *   const { pass, reason } = await judgeUserGotWhatTheyWanted(userMessage, botReply, stateDir, { prompt: customPrompt });
 *   or use default prompt with skillHint: 'cron' | 'browser' | 'memory' | 'home-assistant' | 'write' | 'edit' | 'me'
 */

import dotenv from 'dotenv';
import { getEnvPath } from '../../../lib/util/paths.js';

/**
 * @param {string} userMessage - What the user asked.
 * @param {string} botReply - The reply the bot produced.
 * @param {string} stateDir - State dir for config/env (LLM API key etc.).
 * @param {{ prompt?: string, skillHint?: string }} [opts] - If prompt is set, use it. Else use skillHint to build a default prompt.
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
export async function judgeUserGotWhatTheyWanted(userMessage, botReply, stateDir, opts = {}) {
  const prevStateDir = process.env.PASTURE_STATE_DIR;
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    dotenv.config({ path: getEnvPath() });
    const { chat } = await import('../../../llm.js');
    const prompt =
      opts.prompt ||
      buildDefaultJudgePrompt(userMessage, botReply, opts.skillHint || 'skill');
    const response = await chat([{ role: 'user', content: prompt }]);
    const trimmed = (response || '').trim().toUpperCase();
    const pass = trimmed.startsWith('YES');
    return { pass, reason: (response || '').trim().slice(0, 600) };
  } finally {
    if (prevStateDir !== undefined) process.env.PASTURE_STATE_DIR = prevStateDir;
    else delete process.env.PASTURE_STATE_DIR;
  }
}

/**
 * @param {string} userMessage
 * @param {string} botReply
 * @param {string} skillHint - 'cron' | 'browser' | 'memory' | 'write' | 'edit' | 'me' | 'home-assistant' | 'vision' | 'apply-patch' | 'read' | 'go-read' | 'core' | 'go-write' | 'search' | 'speech' | 'gog' | 'skill'
 */
function buildDefaultJudgePrompt(userMessage, botReply, skillHint) {
  const criteria = {
    cron:
      'The reply must deliver the actual outcome of the cron skill. For listing: show a real list of reminders or explicitly say there are no reminders. For adding: confirm the reminder was scheduled — a plain-English confirmation like "I\'ll remind you every hour" or "Reminder set for 9am" is sufficient; do NOT require the raw cron expression or verbose details. For "send me X in N minutes"-style requests, confirming it is scheduled is the correct outcome (the message is not sent immediately, it is scheduled). For removing: confirm removal or explain what was removed. A reply that only explains reminders or offers to help without showing the outcome is NO. Reply should be in the same language as the user.',
    browser:
      'The reply must deliver the requested content. For news/headlines: must contain headlines, a summary, or current news. For search/navigate: must contain relevant content from the search or page. For non-news queries: must answer with real content, not only a generic news block. A reply that says it cannot do it, or gives only setup/error text without the requested data, is NO. Do NOT evaluate whether the data is real-time, verified, or from a trusted source — that is outside the scope of this test. Evaluate only whether the reply CONTAINS the type of content the user requested (headlines, weather info, prices, search results, page summaries, etc.). If the reply provides partial information (e.g. confirms no nonstop flights exist, or gives relevant links/guidance) because booking sites or dynamic pages block full access, that is acceptable — answer YES if the reply attempts a genuine response with any relevant content.',
    memory:
      'The reply must show that memory was used. If the user asked to recall something: the reply must reference or state what was stored. If the bot says it does not know, does not have that information, or could not find it, answer NO. A reply that only explains memory without returning recalled content is NO.',
    write:
      'The reply must confirm the file was written, created, or saved (e.g. path, filename, or clear success). A reply that refuses to write, only explains how to write, or errors without confirming the write happened is NO. Vague or unhelpful output is NO.',
    edit:
      'The reply must confirm the edit was applied (e.g. replaced, updated, changed in file X). A reply that refuses to edit, only explains editing, or errors without confirming the edit happened is NO. Vague or unhelpful output is NO.',
    me:
      'The reply must contain actual substantive information about the user (e.g. from MEMORY.md or profile: name, preferences, projects, things learned). A reply that only says there are no details saved, nothing learned, no profile yet, or "I don\'t have any personal details about you" is NOT what the user wanted — answer NO. Pass (YES) only if the reply includes real profile or memory content about the user. An error or refusing to use the me skill is NO.',
    'home-assistant':
      'The reply must show that Home Assistant was queried and return real data. For "list my lights" or "what lights": must contain a list of light entities or a clear "no lights" after a successful query. For "list devices": must show entities, count, or examples from the API. A reply that only says it cannot reach HA, or gives setup/error without listing any entities, is NO.',
    vision:
      'The reply must reflect that the vision skill was used. For describe: must contain a description of the image or state that the image was analyzed. For generate: must confirm the image was created/saved or sent (path, "created", "sent", or similar). A reply that only explains the skill or refuses without trying is NO.',
    'apply-patch':
      'The reply must confirm the patch was applied (e.g. file updated, patch applied, change made). A reply that refuses to apply, only explains patching, or errors without confirming the edit happened is NO.',
    read:
      'The reply must contain actual file contents or a clear summary of what was read (or state that the file was read). A reply that refuses to read, only explains the read skill, or errors without showing content is NO.',
    'go-read':
      'The reply must show the result of the command: listing of files/dirs, file contents, or current path. A reply that refuses, only explains the skill, or errors without showing the requested data is NO.',
    core:
      'The reply must show the result of the core command: listing, file contents, path, or confirmation of the operation. A reply that refuses, only explains, or errors without delivering the result is NO.',
    'go-write':
      'The reply must confirm the filesystem change (file created, copied, moved, removed, or permissions changed). A reply that refuses or errors without confirming the operation is NO.',
    search:
      'The reply must deliver search or navigation results: real content from the web (time, weather, snippet, or page content). A reply that only says it cannot search, or gives setup/error without any fetched content, is NO.',
    speech:
      'The reply must reflect that the speech skill was used: for transcribe, the transcript or summary; for synthesize/reply_as_voice, confirmation that audio was generated or sent. A reply that only explains the skill or refuses without trying is NO. If the user asked for voice and the bot clearly could not (e.g. not configured), a short explanation is acceptable only if no voice was requested as the main mission.',
    gog:
      'The reply must show that gog was used: real data from Gmail/Calendar/Drive/etc., or a clear "no results" / empty list. A reply that only says it cannot use gog, or gives setup/error without attempting the requested action, is NO. If not configured, a brief explanation is acceptable.',
    'agent-send':
      'The user asked a question that should be handled by a team specialist (matched by topic/skills, not by naming an agent). The reply must include that sub-agent\'s actual answer or a clear quote from them — not only "I sent" or "I asked" without content. If no specialist was available (not linked), explaining that clearly or answering directly without hallucinating a sub-agent is acceptable. A hallucinated send with no sub-agent content is NO.',
    skill:
      'The reply must deliver what the user asked for: real data (e.g. list, result), a clear outcome, or an explicit "no items" / "nothing found" where that is the correct answer. Polite non-answers, setup instructions alone, or vague text that does not fulfill the request are NO. Error messages are not "what they wanted" unless the user asked for help.',
  };
  const hint = criteria[skillHint] || criteria.skill;
  return `You are a test judge. The user asked:

"${userMessage}"

The bot replied:

---
${botReply}
---

Did the user GET WHAT THEY WANTED? ${hint}

Answer with exactly one line: YES or NO. Then add one short sentence explaining why.`;
}
