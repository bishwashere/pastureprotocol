/**
 * Single central executor. The agent picks the right skill from the list and runs it here.
 * Skills are shortcuts/recipes (SKILL.md + one entry in the map); all heavy lifting is shared.
 * No per-skill babysitters—one dispatcher, one place.
 */

import { executeCron } from '../lib/agent/executors/cron.js';
import { executeBrowser } from '../lib/agent/executors/browser.js';
import { executeBrowse } from '../lib/agent/executors/browse.js';
import { executeMemory } from '../lib/agent/executors/memory.js';
import { executeVision } from '../lib/agent/executors/vision.js';
import { executeGog } from '../lib/agent/executors/gog.js';
import { executeRead } from '../lib/agent/executors/read.js';
import { executeWrite } from '../lib/agent/executors/write.js';
import { executeEdit } from '../lib/agent/executors/edit.js';
import { executeApplyPatch } from '../lib/agent/executors/apply-patch.js';
import { executeGoRead } from '../lib/agent/executors/go-read.js';
import { executeGoWrite } from '../lib/agent/executors/go-write.js';
import { executeExec } from '../lib/agent/executors/exec.js';
import { executeSpeech } from '../lib/agent/executors/speech.js';
import { executeHomeAssistant } from '../lib/agent/executors/home-assistant.js';
import { executeMe } from '../lib/agent/executors/me.js';
import { executeSshInspect } from '../lib/agent/executors/ssh-inspect.js';
import { executeAgentSend } from '../lib/agent/executors/agent-send.js';
import { executeBackgroundTasks } from '../lib/agent/executors/background-tasks.js';
import { executeGithub } from '../lib/agent/executors/github.js';
import { executeGmail } from '../lib/agent/executors/gmail.js';
import { executeCalendar } from '../lib/agent/executors/calendar.js';
import { executeEvaluateTeamCapability } from '../lib/agent/executors/evaluate-team-capability.js';
import { executeProjectWorkflow } from '../lib/agent/executors/project-workflow.js';
import { executeMongodb } from '../lib/agent/executors/mongodb.js';
import { executeHttp } from '../lib/agent/executors/http.js';

const EXECUTORS = {
  cron: executeCron,
  search: executeBrowser,
  browse: executeBrowse,
  vision: executeVision,
  memory: executeMemory,
  speech: executeSpeech,
  gog: executeGog,
  read: executeRead,
  write: executeWrite,
  edit: executeEdit,
  'apply-patch': executeApplyPatch,
  'go-read': executeGoRead,
  'go-write': executeGoWrite,
  exec: executeExec,
  'home-assistant': executeHomeAssistant,
  me: executeMe,
  'ssh-inspect': executeSshInspect,
  'agent-send': executeAgentSend,
  'background-tasks': executeBackgroundTasks,
  github: executeGithub,
  gmail: executeGmail,
  calendar: executeCalendar,
  'evaluate-team-capability': executeEvaluateTeamCapability,
  'project-workflow': executeProjectWorkflow,
  mongodb: executeMongodb,
  http: executeHttp,
};

/**
 * Normalize a skill result string into a structured outcome.
 *
 * Both shapes are recognized as failures:
 *   - {"error": "..."} (any whitespace, any key order)
 *   - {"ok": false, ...}
 *
 * Anything else (plain prose, valid JSON without an error field, empty)
 * is treated as success. This is the single source of truth for "did the
 * skill fail?" — replaces fragile `result.startsWith('{"error":')` checks
 * that miss pretty-printed JSON and the `{ ok: false }` shape.
 *
 * @param {string} result
 * @returns {{ ok: boolean, error?: string, raw: string }}
 */
export function parseSkillResult(result) {
  const raw = typeof result === 'string' ? result : '';
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, raw };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const explicitFail = parsed.ok === false;
        const errStr = typeof parsed.error === 'string' ? parsed.error.trim() : '';
        if (explicitFail || errStr) {
          return { ok: false, error: errStr || 'Skill failed', raw };
        }
      }
    } catch (_) {}
  }
  return { ok: true, raw };
}

function logSkillVerification(skillId, result) {
  const raw = typeof result === 'string' ? result.trim() : '';
  if (!raw || !raw.startsWith('{')) return;
  try {
    const parsed = JSON.parse(raw);
    const verification = parsed?.verification;
    if (!verification || typeof verification !== 'object') return;
    const path = parsed?.path ? ` path=${parsed.path}` : '';
    const method = verification.method ? ` method=${verification.method}` : '';
    const bytes = Number.isFinite(verification.actualBytes)
      ? ` bytes=${verification.actualBytes}`
      : Number.isFinite(verification.bytes)
        ? ` bytes=${verification.bytes}`
        : '';
    const sha = verification.sha256 ? ` sha256=${String(verification.sha256).slice(0, 12)}` : '';
    console.log(`[skills] ${skillId} verification:${path}${method} verified=${verification.verified === true}${bytes}${sha}`);
  } catch (_) {}
}

/**
 * Skills disabled in group chats. Default-deny anything that mutates the host
 * workspace, talks to owner-only external services, or fans out into a nested
 * agent that could re-enable those. Group participants are not the bot owner;
 * letting any of them trigger these is a safety/security exposure.
 *
 * Imported by skills/loader.js so the runtime gate and the LLM tool-schema
 * gate can never drift apart.
 */
export const GROUP_BLOCKED_SKILLS = new Set([
  'go-read',
  'go-write',
  'exec',
  'ssh-inspect',
  'agent-send',
  'write',
  'edit',
  'apply-patch',
  'home-assistant',
  'gmail',
  'calendar',
  'gog',
  'mongodb',
  'background-tasks',
  'cron',
]);

/**
 * @param {string} skillId - e.g. cron | search | memory | go-read | go-write
 * @param {object} ctx - storePath, jid, workspaceDir, scheduleOneShot, startCron, isGroup
 * @param {object} args - Parsed LLM tool arguments
 * @param {string} [toolName] - For multi-tool skills (e.g. memory_search, memory_get)
 * @returns {Promise<string>}
 */
export async function executeSkill(skillId, ctx, args, toolName) {
  if (GROUP_BLOCKED_SKILLS.has(skillId) && ctx?.isGroup) {
    return JSON.stringify({ error: `${skillId} is not available in group chats.` });
  }
  const run = EXECUTORS[skillId];
  if (!run) return JSON.stringify({ error: `Unknown skill: ${skillId}` });
  try {
    const result = await run(ctx, args, toolName);
    const normalized = typeof result === 'string' ? result : JSON.stringify(result);
    logSkillVerification(skillId, normalized);
    return normalized;
  } catch (err) {
    console.error('[skills]', skillId, err.message);
    return JSON.stringify({ error: err.message });
  }
}
