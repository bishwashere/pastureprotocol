/**
 * Standalone entrypoint to run a single cron job in a brand-new agent session (separate process).
 * Reads job payload from stdin as JSON; writes { "textToSend": "..." } to stdout.
 * The main process uses this so cron never runs in the same bot/agent session as active chat.
 *
 * Usage: node cron/run-job.js < payload.json
 * Payload: { "message": "...", "jid": "...", "storePath": "?", "workspaceDir": "?" }
 */

import { getEnvPath, getCronStorePath, getWorkspaceDir } from '../lib/paths.js';
import dotenv from 'dotenv';
import { getSkillContext } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent.js';
import { getTimezoneContextLine } from '../lib/timezone.js';

dotenv.config({ path: getEnvPath() });

const CRON_EXECUTOR_RULE = `This is a cron executor run: you are fulfilling a reminder the user already set. They chose the content when they created the reminder—do NOT ask for clarification (e.g. weather location, "current or 7-day?", or news scope). Use the search skill with concrete queries: for weather use e.g. "current weather Enola PA" or "weather [place name]"; for "top N news" use search with query "top N news" (e.g. "top 5 news") to fetch real headlines with links, not a list of source websites. Execute and return the combined result.`;

function buildCronSystemPrompt() {
  return `You are Pasture. Reply concisely. Use run_skill when you need search, browse, vision, cron, or memory. Do not use <think> or any thinking/reasoning blocks—output only your final reply.\n\n${getTimezoneContextLine()}\n\n# Cron executor\n${CRON_EXECUTOR_RULE}`;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const message = payload.message && String(payload.message).trim();
  const jid = payload.jid && String(payload.jid).trim();
  if (!message || !jid) {
    console.error(JSON.stringify({ error: 'message and jid required' }));
    process.exit(1);
  }
  const storePath = payload.storePath && String(payload.storePath).trim() || getCronStorePath();
  const workspaceDir = payload.workspaceDir && String(payload.workspaceDir).trim() || getWorkspaceDir();
  const noop = () => {};
  const ctx = { storePath, jid, workspaceDir, scheduleOneShot: noop, startCron: noop };
  const { runSkillTool, getFullSkillDoc, resolveToolName } = getSkillContext();
  const toolsToUse = Array.isArray(runSkillTool) && runSkillTool.length > 0 ? runSkillTool : [];
  const { textToSend } = await runAgentTurn({
    userText: message,
    ctx,
    systemPrompt: buildCronSystemPrompt(),
    tools: toolsToUse,
    historyMessages: [],
    getFullSkillDoc,
    resolveToolName,
  });
  process.stdout.write(JSON.stringify({ textToSend }) + '\n');
}

main().catch((err) => {
  // Write error as JSON to stdout so parent can parse it; stderr may have noisy logs from deps
  process.stdout.write(JSON.stringify({ error: err.message || String(err) }) + '\n');
  process.exit(1);
});
