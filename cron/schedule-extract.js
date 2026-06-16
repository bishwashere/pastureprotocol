/**
 * Ask the LLM to interpret natural-language schedule requests into structured JSON.
 * Used only to create cron jobs; the JSON is never sent to the user.
 */

import { chat as llmChat } from '../llm.js';
import { getResolvedTimezone, getResolvedTimeFormat } from '../lib/util/timezone.js';

const SCHEDULE_SYSTEM = `You are a task interpreter. The user may:
A) Ask to schedule a reminder or to be sent a message at a future time.
B) Ask to list or see their existing scheduled jobs (crons, reminders, what's scheduled).

Current date and time (use for "tomorrow", "8am", etc.): {{NOW_ISO}} (readable: {{NOW_READABLE}}).

Respond with ONLY a single JSON object. No markdown, no code fence, no <think> blocks, no other text. Do not use <think> or any thinking tags—output only the JSON object.

If the user wants to LIST or SEE their scheduled jobs (e.g. "what are my crons?", "show my reminders", "list scheduled", "what do I have scheduled?", "do I have any reminders?"), respond with: {"schedule":false,"action":"list_schedules"}

If the user wants to CREATE a schedule/reminder, use exactly one of these shapes:
1) One-time: {"schedule":true,"type":"once","message":"what to send","at":"ISO8601"}
2) Recurring: {"schedule":true,"type":"recurring","message":"what to send","cron":"0 8 * * *","tz":"America/New_York"}
   Cron: 5 fields (minute hour day-of-month month day-of-week). "0 8 * * *" = 8am daily, "0 9 * * 1" = 9am Mondays.
3) Series (same message at multiple times): {"schedule":true,"type":"series","message":"what to send","times":["ISO8601","ISO8601","ISO8601"]}
4) Multiple (different message at different time each): {"schedule":true,"type":"multiple","items":[{"message":"first message","at":"ISO8601"},{"message":"second message","at":"ISO8601"}]}

If the user is just chatting (not scheduling, not listing), respond with: {"schedule":false}

Rules:
- "at" and "times" must be exact full ISO 8601 timestamps (e.g. 2026-02-19T14:30:00.000Z) with date and time. Schedules are saved with these exact times. Use {{NOW_ISO}} as the base. For "tomorrow 8am" use the correct date and 08:00 in ISO 8601.
- For relative times (e.g. "in 5 minutes", "in two hours") compute the exact future moment (now + duration) and output that as a single ISO 8601 string. Accept both digits ("1 minute") and words ("one minute").
- "message" is the exact content to send (e.g. "hello", "HI").
- For "every minute for the next 3 minutes" use type "series" with 3 "times" at 1min, 2min, 3min from now.
- For "send me X in 1 minute and Y in 2 minutes" (two different messages at two times) use type "multiple" with "items": [{"message":"X","at":"ISO8601"},{"message":"Y","at":"ISO8601"}].
- tz is IANA. Omit for recurring if unclear.
- Output only the JSON object, nothing else.`;

function stripThinking(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();
  // Unclosed <think>: drop from <think> up to (and keep) first { so we keep JSON
  if (/<think>/i.test(s)) {
    const open = s.search(/\{/);
    if (open >= 0) s = s.slice(open);
    else s = s.replace(/<think>[\s\S]*/gi, '').trim();
  }
  return s;
}

/**
 * Extract JSON from LLM response. Handles <think>...</think>, ```json```, or raw {...}.
 */
function parseJsonReply(raw) {
  let s = stripThinking(raw).trim();
  // If response is "<think>...</think>\n{...}", take the part after </think>
  const afterThink = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (afterThink !== s) s = afterThink;
  const jsonBlock = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  let toParse = jsonBlock ? jsonBlock[1].trim() : s;
  const brace = toParse.indexOf('{');
  if (brace > 0) toParse = toParse.slice(brace);
  try {
    return JSON.parse(toParse);
  } catch {
    return null;
  }
}

const MAX_SCHEDULE_RETRIES = 3;

/**
 * Call LLM to interpret user message as a schedule request. Returns structured schedule or { schedule: false }.
 * Retries up to MAX_SCHEDULE_RETRIES when the response is not valid JSON or missing required fields.
 * @param {string} userMessage
 * @param {Date} [now]
 * @returns {Promise<{ schedule: boolean, type?: string, message?: string, at?: string, cron?: string, tz?: string, times?: string[] } | null>}
 */
export async function extractSchedule(userMessage, now = new Date()) {
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) return null;
  const nowIso = now.toISOString();
  const tz = getResolvedTimezone();
  const fmt = getResolvedTimeFormat();
  const nowReadable = (() => {
    try {
      return now.toLocaleString(undefined, { timeZone: tz, dateStyle: 'full', timeStyle: 'short', hour12: fmt === '12' });
    } catch {
      return now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
    }
  })();
  const system = SCHEDULE_SYSTEM
    .replace('{{NOW_ISO}}', nowIso)
    .replace('{{NOW_READABLE}}', nowReadable + ` (${tz})`);

  let messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= MAX_SCHEDULE_RETRIES; attempt++) {
    const raw = await llmChat(messages);
    const parsed = parseJsonReply(raw);
    if (parsed && typeof parsed.schedule === 'boolean') return parsed;
    const preview = typeof raw === 'string' ? raw.slice(0, 200).replace(/\s+/g, ' ') : '';
    console.log('[schedule extract] attempt', attempt + 1, '— invalid response (first 200 chars):', preview);
    if (attempt >= MAX_SCHEDULE_RETRIES) {
      console.log('[schedule extract] Parsed:', parsed == null ? 'null' : `schedule=${parsed?.schedule} (typeof schedule=${typeof parsed?.schedule})`);
      return null;
    }
    messages = messages.concat(
      { role: 'assistant', content: typeof raw === 'string' ? raw : '' },
      {
        role: 'user',
        content: 'Your previous reply was not valid. Respond with ONLY a single JSON object, no markdown, no code fence, no other text. Required: "schedule" must be true or false. If scheduling, include "type", "message", and "at" (ISO 8601) or "cron" as specified in the system prompt.',
      }
    );
  }
  return null;
}
