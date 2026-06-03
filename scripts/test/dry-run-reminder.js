/**
 * Dry-run test: step-by-step trace of "Remind me to call Bishwas tomorrow at 5.30 p.m."
 * and edge case "Remind me next week on the blue moon."
 *
 * Usage:
 *   node scripts/test/dry-run-reminder.js
 *   node scripts/test/dry-run-reminder.js "Remind me to call Bishwas tomorrow at 5.30 p.m."
 *   node scripts/test/dry-run-reminder.js "Remind me next week on the blue moon."
 *   node scripts/test/dry-run-reminder.js "Remind me to call Bishwas tomorrow at 5.30 p.m." --live
 *
 * Without --live: prints what WOULD be sent to the LLM and how the loop would run (no API call).
 * With --live: calls the real LLM and executeSkill (uses temp cron store).
 */

import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCronStorePath, getWorkspaceDir, getEnvPath } from '../../lib/paths.js';
import dotenv from 'dotenv';

dotenv.config({ path: getEnvPath() });

import { getSkillContext } from '../../skills/loader.js';
import { chatWithTools } from '../../llm.js';
import { executeSkill } from '../../skills/executor.js';
import { getSchedulingTimeContext } from '../../lib/timezone.js';

const DEFAULT_MSG = 'Remind me to call Bishwas tomorrow at 5.30 p.m.';

function getScheduleSystemPrompt() {
  const timeCtx = getSchedulingTimeContext();
  return `You are a helpful assistant with access to the cron tool for reminders. Reply concisely. Do not use <think> or any thinking/reasoning blocks—output only your final reply.

CRITICAL - Choose the right action:
- Use "add" only when the user explicitly asks to CREATE or SET a new reminder (e.g. "remind me in 5 minutes", "send me X tomorrow").
Use the cron tool to add, list, or remove reminders as requested.

${timeCtx.timeContextLine}
Current time UTC (for "at"): ${timeCtx.nowIso}. Examples: "in 1 minute" = ${timeCtx.in1min}; "in 2 minutes" = ${timeCtx.in2min}; "in 3 minutes" = ${timeCtx.in3min}.

Important: job.message must be exactly what the user asked to receive.`;
}

function section(title) {
  console.log('\n' + '─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

function step1BuildPayload(userMessage) {
  const { skillDocs, runSkillTool } = getSkillContext();
  const systemPrompt = getScheduleSystemPrompt();

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const tools = runSkillTool;

  return { messages, tools, systemPrompt, skillDocs };
}

function step1Print(userMessage) {
  section('STEP 1: What we send to the LLM');

  const { messages, tools, systemPrompt, skillDocs } = step1BuildPayload(userMessage);

  console.log('\nFiles / sources used:');
  console.log('  - System prompt = role only (schedule + timezone). Skill docs are in the run_skill tool description, not in system.');
  console.log('  - skills/loader.js: getSkillContext() → runSkillTool with compact list (name + description) in tool description; full doc injected when a skill is called.');
  console.log('  - No memory file is injected into the prompt; memory skill is available for the LLM to call if needed.\n');

  console.log('System prompt (first 800 chars):');
  console.log(systemPrompt.slice(0, 800) + (systemPrompt.length > 800 ? '...' : ''));
  console.log('\nSkill docs (cron part):');
  console.log((skillDocs || '').split('---')[0].trim().slice(0, 500) + '...');
  console.log('\nTools array (what the LLM sees):');
  console.log(JSON.stringify(tools, null, 2));
  console.log('\nMessages (for API):');
  console.log(JSON.stringify(messages.map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) + ((m.content || '').length > 200 ? '...' : '') })), null, 2));
}

function step2Print(llmResponse) {
  section('STEP 2: What the LLM gives back');

  const { content, toolCalls } = llmResponse;
  console.log('Content (optional text):', content ? content.slice(0, 300) : '(empty)');
  console.log('\nTool calls:');
  if (!toolCalls || toolCalls.length === 0) {
    console.log('  (none – LLM replied with text only, e.g. a clarifying question)');
    return null;
  }
  toolCalls.forEach((tc, i) => {
    console.log(`  [${i}] name: ${tc.name}, arguments: ${(tc.arguments || '').slice(0, 200)}${(tc.arguments || '').length > 200 ? '...' : ''}`);
  });
  const first = toolCalls[0];
  const payload = (() => {
    try {
      return JSON.parse(first.arguments || '{}');
    } catch {
      return {};
    }
  })();
  console.log('\nParsed first tool call:');
  console.log('  Tool name:', first.name, '(cron_add / cron_list / cron_remove or run_skill).');
  console.log('  Arguments:', JSON.stringify(payload, null, 2));
  return { payload, toolCalls };
}

function step3Print(payload, storePath) {
  section('STEP 3: What the main loop does');

  const skillId = payload?.skill;
  const runArgs = payload?.arguments && typeof payload.arguments === 'object' ? payload.arguments : {};

  console.log('  - index.js runAgentWithSkills: for each tool_call we parse arguments → skillId and runArgs.');
  console.log('  - We call executeSkill(skillId, ctx, runArgs), NOT a function named "cron.add".');
  console.log('  - Where the function is defined:');
  console.log('    skills/executor.js: EXECUTORS = { cron: executeCron, search: executeBrowser, memory: executeMemory }');
  console.log('    → executeSkill("cron", ctx, runArgs) calls lib/executors/cron.js executeCron(ctx, runArgs)');
  console.log('  - For cron_add we build runArgs: action="add", job={ message, schedule: { kind: "at", at } }.');
  console.log('\n  Cron store path (ctx.storePath):', storePath);
}

function step4Print(storePath) {
  section('STEP 4: After the function runs – where does it write?');

  console.log('  - Cron executor (lib/executors/cron.js) calls cron/store.js: addJob(input, storePath).');
  console.log('  - addJob writes to: ' + storePath);
  console.log('  - That file is ~/.pasture/cron/jobs.json (or PASTURE_STATE_DIR/cron/jobs.json).');
  if (existsSync(storePath)) {
    const raw = readFileSync(storePath, 'utf8');
    console.log('\n  Current jobs.json (first 400 chars):');
    console.log(raw.slice(0, 400) + (raw.length > 400 ? '...' : ''));
  }
}

function step5PrintBlueMoon() {
  section('STEP 5: "Remind me next week on the blue moon" – what happens?');

  console.log('  - LLM may call cron_add with at: "blue moon" (invalid), or reply with text only asking for a real date.');
  console.log('  - lib/executors/cron.js: parseAbsoluteTimeMs("blue moon") → null; coerceSchedule can still pass through invalid "at".');
  console.log('  - In executeCron (add): new Date(input.schedule.at).getTime() is NaN or past check → we throw:');
  console.log('    "One-shot \\"at\\" time must be in the future. Use a future ISO 8601 timestamp."');
  console.log('  - executeSkill catches and returns JSON.stringify({ error: err.message }).');
  console.log('  - index.js: isToolError = true, lastRoundHadToolError = true. We push that error as the tool result to messages.');
  console.log('  - Next round (or after loop): if finalContent is still empty and lastRoundHadToolError, we call chatWithTools(messages, []) with NO tools.');
  console.log('  - LLM sees the tool error in the conversation and must reply with text only → a clarifying question like "When exactly should I remind you?');
  console.log('  - We never send raw error JSON to the user; if we did, the safety net replaces it with a generic "I need a bit more detail—when should I remind you, and what message would you like?"');
}

async function runLive(userMessage, storePath) {
  const { messages, tools } = step1BuildPayload(userMessage);
  const jid = 'dry-run@test';
  const noop = () => {};
  const ctx = {
    storePath,
    jid,
    workspaceDir: getWorkspaceDir(),
    scheduleOneShot: noop,
    startCron: noop,
  };

  const llmResponse = await chatWithTools(messages, tools);
  const parsed = step2Print(llmResponse);
  if (parsed) {
    const { payload, toolCalls } = parsed;
    const name = (toolCalls?.[0]?.name && String(toolCalls[0].name).trim()) || '';
    let skillId;
    let runArgs;
    if (name === 'cron_add' || name === 'cron_list' || name === 'cron_remove') {
      skillId = 'cron';
      if (name === 'cron_add') {
        const at = payload.at && String(payload.at).trim();
        const expr = payload.expr && String(payload.expr).trim();
        runArgs = {
          action: 'add',
          job: {
            message: (payload.message && String(payload.message).trim()) || 'Reminder',
            schedule: expr ? { kind: 'cron', expr, tz: (payload.tz && String(payload.tz).trim()) || undefined } : { kind: 'at', at: at || undefined },
          },
        };
      } else if (name === 'cron_list') runArgs = { action: 'list' };
      else runArgs = { action: 'remove', jobId: (payload.jobId && String(payload.jobId).trim()) || '' };
    } else {
      skillId = payload?.skill;
      runArgs = payload?.arguments && typeof payload.arguments === 'object' ? payload.arguments : {};
    }
    step3Print({ skill: skillId, arguments: runArgs }, storePath);
    if (skillId) {
      console.log('\n  Executing executeSkill now (dry-run store):');
      const result = await executeSkill(skillId, ctx, runArgs);
      console.log('  Result:', result.slice(0, 300) + (result.length > 300 ? '...' : ''));
    }
    step4Print(storePath);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const msgArg = args.filter(a => a !== '--live')[0];
  const userMessage = msgArg || DEFAULT_MSG;

  console.log('Dry run message:', userMessage);
  console.log('Live (call LLM + executeSkill):', live);

  step1Print(userMessage);

  if (live) {
    const tempDir = mkdtempSync(join(tmpdir(), 'pasture-dry-run-'));
    const tempStorePath = join(tempDir, 'cron', 'jobs.json');
    mkdirSync(join(tempDir, 'cron'), { recursive: true });
    writeFileSync(tempStorePath, JSON.stringify({ version: 1, jobs: [] }, null, 2), 'utf8');
    await runLive(userMessage, tempStorePath);
  } else {
    const payload = { skill: 'cron', arguments: { action: 'add', job: { message: 'call Bishwas', schedule: { kind: 'at', at: 'tomorrow 5:30 PM (ISO8601 from LLM)' } } } };
    section('STEP 2: What the LLM gives back (example without --live)');
    console.log('  Typically: tool_calls = [ { name: "cron_add", arguments: \'{"message":"call Bishwas","at":"2026-02-17T17:30:00.000Z"}\' } ]');
    console.log('  So: call cron_add with message and at (no run_skill, no guessing action).');
    step3Print({ skill: 'cron', arguments: { action: 'add', job: { message: 'call Bishwas', schedule: { kind: 'at', at: '2026-02-17T17:30:00.000Z' } } } }, getCronStorePath());
    step4Print(getCronStorePath());
  }

  step5PrintBlueMoon();
  console.log('\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
