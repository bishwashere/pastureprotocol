/**
 * Single central executor. The agent picks the right skill from the list and runs it here.
 * Skills are shortcuts/recipes (SKILL.md + one entry in the map); all heavy lifting is shared.
 * No per-skill babysitters—one dispatcher, one place.
 */

import { executeCron } from '../lib/executors/cron.js';
import { executeBrowser } from '../lib/executors/browser.js';
import { executeBrowse } from '../lib/executors/browse.js';
import { executeMemory } from '../lib/executors/memory.js';
import { executeVision } from '../lib/executors/vision.js';
import { executeGog } from '../lib/executors/gog.js';
import { executeRead } from '../lib/executors/read.js';
import { executeWrite } from '../lib/executors/write.js';
import { executeEdit } from '../lib/executors/edit.js';
import { executeApplyPatch } from '../lib/executors/apply-patch.js';
import { executeGoRead } from '../lib/executors/go-read.js';
import { executeGoWrite } from '../lib/executors/go-write.js';
import { executeSpeech } from '../lib/executors/speech.js';
import { executeHomeAssistant } from '../lib/executors/home-assistant.js';
import { executeMe } from '../lib/executors/me.js';
import { executeCore } from '../lib/executors/core.js';
import { executeSshInspect } from '../lib/executors/ssh-inspect.js';
import { executeAgentSend } from '../lib/executors/agent-send.js';
import { executeGithub } from '../lib/executors/github.js';
import { executeGmail } from '../lib/executors/gmail.js';
import { executeCalendar } from '../lib/executors/calendar.js';

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
  core: executeCore,
  'home-assistant': executeHomeAssistant,
  me: executeMe,
  'ssh-inspect': executeSshInspect,
  'agent-send': executeAgentSend,
  github: executeGithub,
  gmail: executeGmail,
  calendar: executeCalendar,
};

/** go-read and go-write are disabled in group chats; allowed in DMs and dashboard. */
const BLOCKED_IN_GROUP = new Set(['go-read', 'go-write', 'ssh-inspect', 'agent-send']);

/**
 * @param {string} skillId - cron | search | memory | go-read | go-write
 * @param {object} ctx - storePath, jid, workspaceDir, scheduleOneShot, startCron, isGroup
 * @param {object} args - Parsed LLM tool arguments
 * @param {string} [toolName] - For multi-tool skills (e.g. memory_search, memory_get)
 * @returns {Promise<string>}
 */
export async function executeSkill(skillId, ctx, args, toolName) {
  if (BLOCKED_IN_GROUP.has(skillId) && ctx?.isGroup) {
    return JSON.stringify({ error: `${skillId} is not available in group chats.` });
  }
  const run = EXECUTORS[skillId];
  if (!run) return JSON.stringify({ error: `Unknown skill: ${skillId}` });
  try {
    const result = await run(ctx, args, toolName);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err) {
    console.error('[skills]', skillId, err.message);
    return JSON.stringify({ error: err.message });
  }
}
