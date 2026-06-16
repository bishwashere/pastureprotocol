/**
 * One-on-one (private) Telegram chat handler.
 * Handles message normalization, bio flow, dedup, browse-reset, then runs the agent
 * and logs exchanges to main chat log + memory index. No group guard or rate limit.
 */

import { normalizeTelegramMessage } from './telegram-normalize.js';

const BIO_CONFIRM_PROMPT = "Hey, we haven't done some basic setup. Do you want to do it now?";
const BIO_PROMPT =
  "Before we continue — I'd like to know you a bit. Please answer in one message (any format is fine):\n\nWhat is my name?\nWhat is your name?\nWho am I?\nWho are you?";

function isYesReply(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(y|yes|yeah|yep|sure|ok|okay|1|do it|please|go ahead|sounds good)$/.test(t) || t === 'yup';
}

/**
 * Handle a private (one-on-one) Telegram message. No group guard; logs to main memory.
 * @param {import('node-telegram-bot-api').Message} msg
 * @param {{
 *   bot: import('node-telegram-bot-api'),
 *   sock: object,
 *   getChannelsConfig: () => object,
 *   getSpeechConfig: () => object | null,
 *   getUploadsDir: () => string,
 *   transcribe: (apiKey: string, path: string) => Promise<string>,
 *   clearPendingTelegram: (chatId: string) => number,
 *   flushPendingTelegram: (chatId: string) => Promise<void>,
 *   addPendingTelegram: (jidKey: string, text: string) => void,
 *   pendingBioConfirmJids: Set<string>,
 *   pendingBioJids: Set<string>,
 *   bioPromptSentJids: Set<string>,
 *   isYesReply: (text: string) => boolean,
 *   saveBioToConfig: (text: string) => void,
 *   telegramRepliedIds: Set<string>,
 *   MAX_TELEGRAM_REPLIED: number,
 *   resetBrowseSession: (opts: { jid: string }) => Promise<void>,
 *   runPastDueOneShots: () => Promise<void>,
 *   runAgentWithSkills: (sock: object, jid: string, text: string, lastSentByJid: Map, selfJid: string, ourSentIdsRef: object, bioOpts: object) => Promise<void>,
 *   lastSentByJid: Map<string, string>,
 *   ourSentMessageIds: Set<string>,
 *   getMemoryConfig: () => object | null,
 *   indexChatExchange: (config: object, exchange: object) => Promise<void>,
 *   getWorkspaceDir: () => string,
 *   toUserMessage: (err: Error) => string,
 * }} ctx
 */
export async function handleTelegramPrivateMessage(msg, ctx) {
  const chatId = msg.chat?.id;
  if (chatId == null) return;

  const normalized = await normalizeTelegramMessage(msg, {
    bot: ctx.bot,
    getChannelsConfig: ctx.getChannelsConfig,
    getSpeechConfig: ctx.getSpeechConfig,
    getUploadsDir: ctx.getUploadsDir,
    transcribe: ctx.transcribe,
  });
  let { text, replyWithVoice } = normalized;
  text = text.trim();
  if (replyWithVoice && text) {
    text += '\n\n[The user sent a voice message. Reply using the speech skill with action reply_as_voice so your reply is sent as a voice message. Keep your reply conversational and spoken-word friendly: summarize, answer, or respond naturally. Do NOT read out file names, folder names, long paths, or raw file contents unless the user explicitly asks for them.]';
  }

  if (!text) return;
  if (msg.from?.is_bot) return;
  if (text.startsWith('[Pasture]')) return;

  if (ctx.flushPendingTelegram) await ctx.flushPendingTelegram(chatId);
  const jidKey = String(chatId);

  if (ctx.pendingBioConfirmJids.has(jidKey)) {
    ctx.pendingBioConfirmJids.delete(jidKey);
    if (isYesReply(text)) {
      await ctx.bot.sendMessage(chatId, BIO_PROMPT).catch(() => ctx.addPendingTelegram(jidKey, BIO_PROMPT));
      ctx.pendingBioJids.add(jidKey);
    } else {
      await ctx.bot.sendMessage(chatId, "No problem. You can do it later from setup.").catch(() => ctx.addPendingTelegram(jidKey, "No problem. You can do it later from setup."));
    }
    return;
  }
  if (ctx.pendingBioJids.has(jidKey)) {
    ctx.saveBioToConfig(text);
    ctx.pendingBioJids.delete(jidKey);
    await ctx.bot.sendMessage(chatId, "Thanks, I've saved that.").catch(() => ctx.addPendingTelegram(jidKey, "Thanks, I've saved that."));
    return;
  }

  const msgKey = `tg:${chatId}:${msg.message_id}`;
  if (ctx.telegramRepliedIds.has(msgKey)) return;
  ctx.telegramRepliedIds.add(msgKey);
  if (ctx.telegramRepliedIds.size > ctx.MAX_TELEGRAM_REPLIED) {
    const first = ctx.telegramRepliedIds.values().next().value;
    if (first) ctx.telegramRepliedIds.delete(first);
  }

  if (text.toLowerCase() === '/browse-reset') {
    await ctx.resetBrowseSession({ jid: jidKey });
    const reply = 'Browser reset. Next browse will start fresh.';
    await ctx.bot.sendMessage(chatId, reply).catch(() => ctx.addPendingTelegram(String(chatId), reply));
    return;
  }

  if (text.toLowerCase() === '/tasks') {
    const reply = ctx.formatTasksList(jidKey);
    await ctx.bot.sendMessage(chatId, reply).catch(() => ctx.addPendingTelegram(String(chatId), reply));
    return;
  }

  console.log('[telegram]', String(chatId), text.slice(0, 60) + (text.length > 60 ? '…' : ''));
  await ctx.runPastDueOneShots().catch((e) => console.error('[cron] runPastDueOneShots:', e.message));

  const memoryConfig = ctx.getMemoryConfig();
  const logExchange = (exchange) => {
    if (memoryConfig) {
      ctx.indexChatExchange(memoryConfig, exchange).catch((err) => console.error('[memory] auto-index failed:', err.message));
    }
  };

  await ctx.runAgentWithSkills(
    ctx.sock,
    jidKey,
    text,
    ctx.lastSentByJid,
    jidKey,
    { current: ctx.ourSentMessageIds },
    {
      pendingBioJids: ctx.pendingBioJids,
      pendingBioConfirmJids: ctx.pendingBioConfirmJids,
      bioPromptSentJids: ctx.bioPromptSentJids,
      forceVoiceReply: !!replyWithVoice,
      logExchange,
      timingChannel: 'telegram',
      receivedAtMs: Number(msg.date) > 0 ? Number(msg.date) * 1000 : Date.now(),
    }
  ).catch((err) => {
    console.error('Telegram agent error:', err.message);
    const errorText = ctx.toUserMessage(err);
    ctx.bot.sendMessage(chatId, errorText).catch(() => ctx.addPendingTelegram(String(chatId), errorText));
  });
}
