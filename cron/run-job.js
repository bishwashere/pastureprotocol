/**
 * Standalone entrypoint to run a single cron job in a brand-new agent session (separate process).
 * Reads job payload from stdin as JSON; writes { "textToSend": "..." } to stdout.
 * The main process uses this so cron never runs in the same bot/agent session as active chat.
 *
 * Usage: node cron/run-job.js < payload.json
 * Payload: { "message": "...", "jid": "...", "storePath": "?", "workspaceDir": "?", "job": "?" }
 */

import { getEnvPath, getCronStorePath, getWorkspaceDir } from '../lib/util/paths.js';
import dotenv from 'dotenv';
import { getSkillContext } from '../skills/loader.js';
import { runAgentTurn } from '../lib/agent/agent.js';
import { closeCodexAppServerClient } from '../lib/llm/codex-app-server.js';
import { getTimezoneContextLine } from '../lib/util/timezone.js';
import { runConditionalJob } from './conditional.js';

dotenv.config({ path: getEnvPath() });

const CRON_EXECUTOR_RULE = `This is a cron executor run: you are fulfilling a reminder the user already set. They chose the content when they created the reminder—do NOT ask for clarification (e.g. weather location, "current or 7-day?", or news scope). Use the search skill with concrete queries: for weather use e.g. "current weather Enola PA" or "weather [place name]"; for "top N news" use search with query "top N news" (e.g. "top 5 news") to fetch real headlines with links, not a list of source websites. Execute and return the combined result.`;

// Runtime grounding so the LLM stops inventing constraints like "I can't reach
// localhost from here." The daemon IS the local machine: localhost/127.0.0.1
// and LAN URLs are reachable. Prefer http_get for plain JSON; reserve browse
// for actually-rendered pages (login, JS SPA, screenshots).
const RUNTIME_GROUNDING = `You are running as a daemon process on the user's own machine (this same machine, not a remote sandbox). Any localhost / 127.0.0.1 / 192.168.x.x / 10.x.x.x / .local URL the user gives you IS reachable from this process. For plain HTTP / JSON URLs, prefer the http skill (http_get). Use browse only when you actually need a rendered page (login, JS-driven SPA, screenshot). Never tell the user "I can't reach localhost from here" — fetch it.`;

export function buildCronSystemPrompt() {
  return `You are Pasture. Reply concisely. Use run_skill when you need http, search, browse, vision, cron, or memory. Do not use <think> or any thinking/reasoning blocks—output only your final reply.\n\n${RUNTIME_GROUNDING}\n\n${getTimezoneContextLine()}\n\n# Cron executor\n${CRON_EXECUTOR_RULE}`;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const message = payload.message && String(payload.message).trim();
  const jid = payload.jid && String(payload.jid).trim();
  if (!message || !jid) {
    console.error(JSON.stringify({ error: 'message and jid required' }));
    process.exitCode = 1;
    return;
  }
  const storePath = payload.storePath && String(payload.storePath).trim() || getCronStorePath();
  const workspaceDir = payload.workspaceDir && String(payload.workspaceDir).trim() || getWorkspaceDir();
  const conditionalText = await runConditionalJob(payload.job);
  if (conditionalText != null) {
    process.stdout.write(JSON.stringify({ textToSend: conditionalText }) + '\n');
    return;
  }
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

await main()
  .catch((err) => {
    // Write error as JSON to stdout so parent can parse it; stderr may have noisy logs from deps
    process.stdout.write(JSON.stringify({ error: err.message || String(err) }) + '\n');
    process.exitCode = 1;
  })
  .finally(async () => {
    // This is a one-shot process; do not leave the shared Codex child alive after output.
    try { await closeCodexAppServerClient(); } catch (_) {}
  });
