/**
 * Standalone entrypoint for the Tide history nudge (separate from the silence-based follow-up).
 * Runs every N hours (default 2). Looks back over the past week of conversation, picks one
 * interesting thread, and sends a proactive message: "Hey, you mentioned X — want to revisit?
 * Here's another angle:" etc.
 *
 * Reads payload from stdin as JSON; writes { "textToSend": "..." } to stdout.
 *
 * Payload: {
 *   "jid": "...",
 *   "storePath": "?",
 *   "workspaceDir": "?",
 *   "historyItems": [{ "ts": number, "user": string, "assistant": string }, ...],
 *   "bootstrapBlock": "?"
 * }
 */

import { getEnvPath, getCronStorePath, getWorkspaceDir } from '../lib/paths.js';
import dotenv from 'dotenv';
import { getSkillContext } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent.js';
import { getSchedulingTimeContext } from '../lib/timezone.js';
import { buildOneOnOneSystemPrompt } from '../lib/system-prompt.js';
import { buildSessionBootstrapContext } from '../lib/session-bootstrap.js';

dotenv.config({ path: getEnvPath() });

const NUDGE_INSTRUCTION = `

# Tide History Nudge (proactive weekly scan)
You have been given a sample of the user's conversations from the past week.
Your job: pick ONE item — a topic, task, idea, question, or thread — that might be worth revisiting.
Send a single short proactive message. Good patterns:
- "Hey, last week you were looking at [X]. Want to pick that back up, or take a different angle?"
- "We never finished [Y]. Still relevant, or off the table?"
- "You mentioned [Z] a few days ago — here's a quick thought on that if you want to explore it."
Be casual, direct, and specific. Reference the actual thing. Do NOT be vague ("want to chat?").
Do NOT pick something that was clearly resolved or finished unless you have a genuinely new angle.
One message only. No preamble. No "As your AI assistant…".`;

function formatHistoryItems(items) {
  if (!items || !items.length) return '(no history available)';
  return items
    .map((it, i) => {
      const date = it.ts ? new Date(it.ts).toISOString().slice(0, 10) : '';
      const u = String(it.user || '').slice(0, 300);
      const a = String(it.assistant || '').slice(0, 300);
      return `[${i + 1}] ${date}\nUser: ${u}\nAssistant: ${a}`;
    })
    .join('\n\n');
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const jid = payload.jid && String(payload.jid).trim();
  if (!jid) {
    process.stdout.write(JSON.stringify({ error: 'jid required' }) + '\n');
    process.exit(1);
  }
  const storePath = payload.storePath && String(payload.storePath).trim() || getCronStorePath();
  const workspaceDir = payload.workspaceDir && String(payload.workspaceDir).trim() || getWorkspaceDir();
  const historyItems = Array.isArray(payload.historyItems) ? payload.historyItems : [];

  const timeCtx = getSchedulingTimeContext();
  const formattedHistory = formatHistoryItems(historyItems);
  const userText =
    '[Tide Nudge] Current time: ' +
    timeCtx.nowIso +
    '. Here are conversation excerpts from the past week:\n\n' +
    formattedHistory +
    '\n\nPick ONE interesting item from the above history and send a short, casual, proactive message to the user. Reference the actual topic specifically.';

  const noop = () => {};
  const ctx = { storePath, jid, workspaceDir, scheduleOneShot: noop, startCron: noop, groupNonOwner: false };
  const { runSkillTool, getFullSkillDoc, resolveToolName } = getSkillContext();
  const toolsToUse = Array.isArray(runSkillTool) && runSkillTool.length > 0 ? runSkillTool : [];
  const bootstrapBlock =
    (payload.bootstrapBlock && String(payload.bootstrapBlock).trim()) ||
    buildSessionBootstrapContext(workspaceDir).block;
  const systemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + (bootstrapBlock || '') + NUDGE_INSTRUCTION;

  const { textToSend } = await runAgentTurn({
    userText,
    ctx,
    systemPrompt,
    tools: toolsToUse,
    historyMessages: [],
    getFullSkillDoc,
    resolveToolName,
  });
  process.stdout.write(JSON.stringify({ textToSend: textToSend || '' }) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message || String(err) }) + '\n');
  process.exit(1);
});
