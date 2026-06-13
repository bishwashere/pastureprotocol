/**
 * Group Telegram chat handler.
 * Handles message normalization, group guard (rate limit, cron/scan block), then runs the agent
 * and logs exchanges only to group-chat-log (no main memory index).
 * When the bot is not @mentioned, the agent is still run but may choose not to reply (see system prompt).
 */

import { normalizeTelegramMessage } from './telegram-normalize.js';
import {
  isOverRateLimit,
  recordGroupRequest,
  recordMemberSeen,
} from './group-guard.js';
import { appendGroupExchange } from './chat-log.js';
import { getGroupDisplayName, setGroupDisplayName, parseSetDisplayNameMessage } from './group-display-names.js';

/**
 * True if the message explicitly mentions the bot (e.g. @BotUsername).
 * Uses Telegram message entities; if botUsername is missing, returns false so selective-reply applies.
 * @param {import('node-telegram-bot-api').Message} msg
 * @param {string | null | undefined} botUsername - From bot.getMe().username
 */
function isBotMentioned(msg, botUsername) {
  if (!botUsername || !msg?.text) return false;
  const entities = msg.entities || [];
  const atBot = ('@' + botUsername).toLowerCase();
  for (const e of entities) {
    if (e.type === 'mention' && typeof e.offset === 'number' && typeof e.length === 'number') {
      const mention = msg.text.substring(e.offset, e.offset + e.length).toLowerCase();
      if (mention === atBot) return true;
    }
  }
  return false;
}

const BIO_CONFIRM_PROMPT = "Hey, we haven't done some basic setup. Do you want to do it now?";
const BIO_PROMPT =
  "Before we continue — I'd like to know you a bit. Please answer in one message (any format is fine):\n\nWhat is my name?\nWhat is your name?\nWho am I?\nWho are you?";

function isYesReply(text) {
  const t = (text || '').trim().toLowerCase();
  return /^(y|yes|yeah|yep|sure|ok|okay|1|do it|please|go ahead|sounds good)$/.test(t) || t === 'yup';
}

/**
 * Handle a group Telegram message. Applies rate limit and blocks cron/scan for non-owners;
 * logs to group-chat-log only.
 * @param {import('node-telegram-bot-api').Message} msg
 * @param {{
 *   bot: import('node-telegram-bot-api'),
 *   sock: object,
 *   getChannelsConfig: () => object,
 *   getSpeechConfig: () => object | null,
 *   getUploadsDir: () => string,
 *   transcribe: (apiKey: string, path: string) => Promise<string>,
 *   clearPendingTelegram: (chatId: string) => number,
 *   addPendingTelegram: (jidKey: string, text: string) => void,
 *   getOwnerConfig: () => { telegramUserId?: number },
 *   getGroupAddedBy: (chatId: string | number) => number | null,
 *   isOwner: (userId?: number) => boolean,
 *   pendingBioConfirmJids: Set<string>,
 *   pendingBioJids: Set<string>,
 *   bioPromptSentJids: Set<string>,
 *   saveBioToConfig: (text: string) => void,
 *   telegramRepliedIds: Set<string>,
 *   MAX_TELEGRAM_REPLIED: number,
 *   resetBrowseSession: (opts: { jid: string }) => Promise<void>,
 *   runPastDueOneShots: () => Promise<void>,
 *   runAgentWithSkills: (sock: object, jid: string, text: string, lastSentByJid: Map, selfJid: string, ourSentIdsRef: object, bioOpts: object) => Promise<void>,
 *   lastSentByJid: Map<string, string>,
 *   ourSentMessageIds: Set<string>,
 *   getWorkspaceDir: () => string,
 *   toUserMessage: (err: Error) => string,
 *   getBotUsername: () => Promise<string | null> | undefined,
 * }} ctx
 */
export async function handleTelegramGroupMessage(msg, ctx) {
  const chatId = msg.chat?.id;
  if (chatId == null) return;

  const ownerCfg = ctx.getOwnerConfig();
  if (ownerCfg.telegramUserId != null) {
    const addedBy = ctx.getGroupAddedBy(chatId);
    if (addedBy != null && addedBy !== ownerCfg.telegramUserId) {
      return;
    }
  }

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
    text += '\n\n[The user sent a voice message. Reply using the speech skill with action reply_as_voice so your reply is sent as a voice message.]';
  }

  if (!text) return;
  if (msg.from?.is_bot) return;
  if (text.startsWith('[Pasture]')) return;

  const dropped = ctx.clearPendingTelegram(chatId);
  if (dropped > 0) console.log('[telegram] dropped', dropped, 'pending reply(ies) for chat', chatId);
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

  const setMyName = msg.from?.id != null ? parseSetDisplayNameMessage(text) : null;
  if (setMyName != null) {
    setGroupDisplayName('telegram', String(msg.from.id), setMyName);
    const reply = `Got it, I'll call you ${setMyName} in the group.`;
    await ctx.bot.sendMessage(chatId, reply).catch(() => ctx.addPendingTelegram(jidKey, reply));
    return;
  }

  // Group guard: rate limit only. Cron/scan and other criteria are in group.md; the LLM enforces them.
  if (ownerCfg.telegramUserId && !ctx.isOwner(msg.from?.id)) {
    const rateKey = `${chatId}:${msg.from?.id ?? 'unknown'}`;
    if (isOverRateLimit(rateKey)) {
      const messages = typeof ctx.getGroupPromptMessages === 'function' ? ctx.getGroupPromptMessages() : {};
      const rateLimitMsg = messages?.rate_limit_message ?? 'Too many requests from this group. Please wait a minute or ask the bot owner.';
      await ctx.bot.sendMessage(chatId, rateLimitMsg).catch(() => ctx.addPendingTelegram(jidKey, rateLimitMsg));
      return;
    }
    recordGroupRequest(rateKey);
  }

  const preferredName = msg.from?.id != null ? getGroupDisplayName('telegram', String(msg.from.id)) : null;
  const senderName = msg.from
    ? (preferredName && preferredName.trim()) || [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || 'A group member'
    : null;
  if (msg.from?.id != null) recordMemberSeen(String(chatId), msg.from.id);
  // Keep group and one-on-one payloads aligned: pass raw user text.
  // Sender identity is still provided via groupSenderName in bio options.
  const textForAgent = text;

  const botUsername = typeof ctx.getBotUsername === 'function' ? await ctx.getBotUsername().catch(() => null) : null;
  const groupMentioned = isBotMentioned(msg, botUsername);

  console.log('[telegram]', String(chatId), text.slice(0, 60) + (text.length > 60 ? '…' : ''));
  await ctx.runPastDueOneShots().catch((e) => console.error('[cron] runPastDueOneShots:', e.message));

  const workspaceDir = ctx.getWorkspaceDir();
  const logExchange = (exchange) => {
    try {
      appendGroupExchange(workspaceDir, jidKey, exchange);
    } catch (err) {
      console.error('[group-chat-log] write failed:', err.message);
    }
  };

  await ctx.runAgentWithSkills(
    ctx.sock,
    jidKey,
    textForAgent,
    ctx.lastSentByJid,
    jidKey,
    { current: ctx.ourSentMessageIds },
    {
      pendingBioJids: ctx.pendingBioJids,
      pendingBioConfirmJids: ctx.pendingBioConfirmJids,
      bioPromptSentJids: ctx.bioPromptSentJids,
      forceVoiceReply: !!replyWithVoice,
      groupNonOwner: true,
      groupSenderName: senderName || undefined,
      groupMentioned,
      logExchange,
      timingChannel: 'telegram_group',
      receivedAtMs: Number(msg.date) > 0 ? Number(msg.date) * 1000 : Date.now(),
    }
  ).catch((err) => {
    console.error('Telegram agent error:', err.message);
    const errorText = 'Moo — ' + ctx.toUserMessage(err);
    ctx.bot.sendMessage(chatId, errorText).catch(() => ctx.addPendingTelegram(String(chatId), errorText));
  });
}
