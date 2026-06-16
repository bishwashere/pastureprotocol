/**
 * Standalone entrypoint to run one Tide cycle in a separate process (own execution chain).
 * Does not block chat. Reads payload from stdin as JSON; writes { "textToSend": "..." } to stdout.
 * Parent process sends the reply to the user's chat (like cron).
 *
 * Same main LLM as chat; only the Tide (quiet check) instruction is added as an extra skill.
 *
 * Usage: node cron/run-tide.js < payload.json
 * Payload: { "jid": "...", "storePath": "?", "workspaceDir": "?" }
 */

import { getEnvPath, getCronStorePath, getWorkspaceDir } from '../lib/util/paths.js';
import dotenv from 'dotenv';
import { getSkillContext } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent/agent.js';
import { getSchedulingTimeContext } from '../lib/util/timezone.js';
import { buildOneOnOneSystemPrompt } from '../lib/agent/system-prompt.js';
import { buildSessionBootstrapContext } from '../lib/agent/session-bootstrap.js';

dotenv.config({ path: getEnvPath() });

const TIDE_INSTRUCTION = `

# Tide (quiet check)
The chat has been quiet. You must always reply with one short, useful message. Never say "nothing to do" or stay silent.
- If there is a follow-up needed (e.g. waiting on their reply), something finished that needs sign-off, or one concrete next step: say that.
- If there is nothing pending: based on the recent conversation (even if that topic is already completed), suggest something related or ask what they would like to do next. Examples: "We wrapped up X. What would you like to tackle next?" or "Anything else you want to work on based on what we did?"
Be short and helpful. Do not double-text. Quiet is golden.`;

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
  const historyMessages = Array.isArray(payload.historyMessages)
    ? payload.historyMessages.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];
  const timeCtx = getSchedulingTimeContext();
  const userText =
    '[Tide] Chat has been quiet. Current time: ' +
    timeCtx.nowIso +
    '. Based on the last few messages, reply with one short, useful message. If something is pending (follow-up, sign-off, next step), say that. If nothing is pending, ask what they would like to do next or suggest something related to what you were already discussing (even if that is completed). Never reply with "nothing to do" or empty—always say something helpful.';
  const noop = () => {};
  const ctx = { storePath, jid, workspaceDir, scheduleOneShot: noop, startCron: noop, groupNonOwner: false };
  const { runSkillTool, getFullSkillDoc, resolveToolName } = getSkillContext();
  const toolsToUse = Array.isArray(runSkillTool) && runSkillTool.length > 0 ? runSkillTool : [];
  const bootstrapBlock =
    (payload.bootstrapBlock && String(payload.bootstrapBlock).trim()) ||
    buildSessionBootstrapContext(workspaceDir).block;
  const systemPrompt = buildOneOnOneSystemPrompt(workspaceDir) + (bootstrapBlock || '') + TIDE_INSTRUCTION;
  const { textToSend } = await runAgentTurn({
    userText,
    ctx,
    systemPrompt,
    tools: toolsToUse,
    historyMessages,
    getFullSkillDoc,
    resolveToolName,
  });
  process.stdout.write(JSON.stringify({ textToSend: textToSend || '' }) + '\n');
}

main().catch((err) => {
  process.stdout.write(JSON.stringify({ error: err.message || String(err) }) + '\n');
  process.exit(1);
});
