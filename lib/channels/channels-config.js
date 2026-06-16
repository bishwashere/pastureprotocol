/**
 * Channels config (WhatsApp, Telegram). Reads from config.json; botToken can be
 * an env var name (e.g. "TELEGRAM_BOT_TOKEN") or a literal. Same pattern as llm apiKey.
 */

import { readFileSync, existsSync } from 'fs';
import { getConfigPath } from './paths.js';

function fromEnv(val) {
  if (val == null) return val;
  const s = String(val).trim();
  if (process.env[s] !== undefined) return process.env[s];
  return val;
}

/**
 * @returns {{ whatsapp: { enabled: boolean }, telegram: { enabled: boolean, botToken: string | null } }}
 */
export function getChannelsConfig() {
  let config = {};
  try {
    const path = getConfigPath();
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw?.trim()) config = JSON.parse(raw);
    }
  } catch (_) {
    // Invalid or missing; use defaults below.
  }
  const channels = config.channels || {};
  const whatsapp = channels.whatsapp;
  const telegram = channels.telegram;

  const whatsappEnabled = whatsapp?.enabled !== false;
  const telegramToken = fromEnv(telegram?.botToken) ?? process.env.TELEGRAM_BOT_TOKEN;
  const hasToken = !!String(telegramToken || '').trim();
  // Enabled if explicitly true, or if token is set and not explicitly disabled (backward compat with env-only).
  const telegramEnabled = hasToken && (telegram?.enabled === true || telegram?.enabled !== false);

  return {
    whatsapp: { enabled: whatsappEnabled },
    telegram: {
      enabled: telegramEnabled,
      botToken: hasToken ? String(telegramToken).trim() : null,
    },
  };
}
