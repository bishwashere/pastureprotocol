/**
 * Work-mode classifier — single-agent (default) vs. multi-agent (work mode).
 *
 * The decision lives in lib/agent/templates/work-mode-classifier.md. This file
 * is just the substrate: it gathers the input, calls the MD prompt via
 * md-llm.js, and returns a structured result. Per AGENTS.md, JS does NOT
 * branch on user text here — it asks the LLM and returns what the LLM said.
 */

import { runMdPrompt } from './md-llm.js';
import {
  getSessionWorkMode,
  setSessionWorkMode,
  WORK_MODE_ENABLED_ACK,
  WORK_MODE_DISABLED_ACK,
} from '../context/chat-session.js';

const VALID_TOGGLES = new Set(['enable', 'disable', 'no_change']);

/**
 * Ask the LLM whether the user wants to toggle work mode for this session.
 *
 * @param {object} opts
 * @param {string} opts.userText - The latest user message.
 * @param {'single'|'multi'} opts.currentMode - The mode the session is currently in.
 * @param {string} [opts.agentId] - Forwarded to the LLM client.
 * @param {function} [opts.llmChat] - Test seam.
 * @returns {Promise<{ toggle: 'enable'|'disable'|'no_change', reason: string } | null>}
 *   Null when the LLM call or parse fails — the caller keeps the current mode.
 */
export async function classifyWorkModeToggle({ userText, currentMode, agentId, llmChat = null } = {}) {
  if (!userText || !String(userText).trim()) return null;
  const mode = currentMode === 'multi' ? 'multi' : 'single';

  const result = await runMdPrompt({
    promptName: 'work-mode-classifier',
    user: { currentMode: mode, userText: String(userText) },
    agentId,
    purpose: 'work_mode_classifier',
    llmChat,
  });

  if (!result || typeof result !== 'object') return null;
  const toggle = VALID_TOGGLES.has(result.toggle) ? result.toggle : 'no_change';
  const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
  return { toggle, reason };
}

/**
 * Decide-and-apply: classify, persist the new mode if the LLM said to toggle,
 * and return the resulting state (plus an acknowledgement string the caller
 * can send back to the user).
 *
 * @param {object} opts
 * @param {string} opts.userText
 * @param {string} opts.logKey - chat-session storage key.
 * @param {string} [opts.agentId]
 * @param {function} [opts.llmChat] - Test seam.
 * @returns {Promise<{
 *   modeBefore: 'single'|'multi',
 *   modeAfter: 'single'|'multi',
 *   toggled: boolean,
 *   reason: string,
 *   ack: string | null,
 * }>}
 */
export async function resolveWorkModeForTurn({ userText, logKey, agentId, llmChat = null } = {}) {
  const modeBefore = getSessionWorkMode(logKey);
  const classification = await classifyWorkModeToggle({
    userText,
    currentMode: modeBefore,
    agentId,
    llmChat,
  });

  if (!classification || classification.toggle === 'no_change') {
    return {
      modeBefore,
      modeAfter: modeBefore,
      toggled: false,
      reason: classification?.reason || '',
      ack: null,
    };
  }

  const desired = classification.toggle === 'enable' ? 'multi' : 'single';
  if (desired === modeBefore) {
    return {
      modeBefore,
      modeAfter: modeBefore,
      toggled: false,
      reason: classification.reason || '',
      ack: null,
    };
  }

  setSessionWorkMode(logKey, desired);
  return {
    modeBefore,
    modeAfter: desired,
    toggled: true,
    reason: classification.reason || '',
    ack: desired === 'multi' ? WORK_MODE_ENABLED_ACK : WORK_MODE_DISABLED_ACK,
  };
}
