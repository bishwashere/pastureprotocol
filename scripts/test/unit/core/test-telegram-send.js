/**
 * Real Telegram send test: sends one message via the Telegram Bot API.
 * Use to verify that sending to Telegram really works (no mocks).
 *
 * Requires: TELEGRAM_BOT_TOKEN and TEST_CHAT_ID in env or ~/.pasture/.env.
 * Run: pnpm run test:telegram-send
 * Or: TEST_CHAT_ID=123456789 node scripts/test/test-telegram-send.js
 */

import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { getEnvPath } from '../../../../lib/util/paths.js';
import { getChannelsConfig } from '../../../../lib/channels/channels-config.js';

dotenv.config({ path: getEnvPath() });

const token = process.env.TELEGRAM_BOT_TOKEN || getChannelsConfig().telegram?.botToken;
const chatId = process.env.TEST_CHAT_ID;

if (!token || !String(token).trim()) {
  console.error('TELEGRAM_BOT_TOKEN (or telegram.botToken in config) is required.');
  process.exit(1);
}
if (!chatId || !String(chatId).trim()) {
  console.log('SKIP telegram-send: TEST_CHAT_ID not set (optional live test).');
  process.exit(0);
}

const bot = new TelegramBot(token.trim(), { polling: false });
const text = `Pasture send test: ${new Date().toISOString()}`;

try {
  const sent = await bot.sendMessage(chatId.trim(), text);
  console.log('Sent to Telegram:', sent.message_id ? `message_id=${sent.message_id}` : 'ok');
  process.exit(0);
} catch (err) {
  console.error('Telegram send failed:', err.message);
  process.exit(1);
}
