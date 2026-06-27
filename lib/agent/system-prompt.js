/**
 * Shared one-on-one system prompt: soul + identity (WhoAmI/MyHuman or config bio) + paths + time.
 * Used by main chat (index.js), run-tide, and chat-dashboard so the same LLM context is built in one place.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getStateDir, getWorkspaceDir, getConfigPath } from '../util/paths.js';
import { getSchedulingTimeContext } from '../util/timezone.js';
import { getGithubSystemPromptBlock } from '../context/github-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = (process.env.PASTURE_INSTALL_DIR && join(process.env.PASTURE_INSTALL_DIR)) || join(__dirname, '..');
const DEFAULT_WORKSPACE_DIR = join(INSTALL_DIR, 'workspace-default');

const SOUL_MD = 'SOUL.md';
const WHO_AM_I_MD = 'WhoAmI.md';
const MY_HUMAN_MD = 'MyHuman.md';
const LESSONS_MD = 'lessons.md';
const RUNTIME_GROUNDING_MD = 'runtime-grounding.md';

function readTemplateMd(filename) {
  try {
    const p = join(__dirname, 'templates', filename);
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

const FALLBACK_RUNTIME_GROUNDING = '# Runtime\nYou are running as a daemon process on the user\'s own machine (this same machine, not a remote sandbox). Any localhost / 127.0.0.1 / 192.168.x.x / 10.x.x.x / .local URL the user gives you IS reachable from this process. For plain HTTP / JSON URLs, prefer the http skill (http_get). Never tell the user "I can\'t reach localhost from here" - fetch it.\n\nPasture Protocol\'s fixed runtime home is `~/.pasture` for every user unless config says otherwise. Treat `~/.pasture` as the first source of truth for Pasture state, config, logs, agent workspaces, Brain data, and runtime-owned files.';

// Runtime grounding is always injected after per-user SOUL.md, so existing
// installs receive shipped grounding changes without editing local state.
export const RUNTIME_GROUNDING_BLOCK = '\n\n' + (readTemplateMd(RUNTIME_GROUNDING_MD) || FALLBACK_RUNTIME_GROUNDING);

function readWorkspaceMd(workspaceDir, filename) {
  try {
    const p = join(workspaceDir, filename);
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

function readDefaultSoul() {
  try {
    const p = join(DEFAULT_WORKSPACE_DIR, SOUL_MD);
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch (_) {}
  return '';
}

function getBioFromConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const full = JSON.parse(raw);
    return full.bio || null;
  } catch (_) {
    return null;
  }
}

/**
 * Build the one-on-one system prompt (soul + identity + paths + time). Read-only; no side effects.
 * @param {string} [workspaceDir] - Workspace directory; defaults to getWorkspaceDir() when omitted.
 * @returns {string}
 */
export function buildOneOnOneSystemPrompt(workspaceDir) {
  const dir = workspaceDir && String(workspaceDir).trim() || getWorkspaceDir();
  const timeCtx = getSchedulingTimeContext();
  const timeBlock = `\n\n${timeCtx.timeContextLine}\nCurrent time UTC (for scheduling "at"): ${timeCtx.nowIso}. Examples: "in 1 minute" = ${timeCtx.in1min}; "in 2 minutes" = ${timeCtx.in2min}; "in 3 minutes" = ${timeCtx.in3min}.`;
  const pathsLine = `\n\nPasture Protocol on this system: state dir ${getStateDir()}, workspace ${dir}. When the user asks where pasture is installed or where config is, use the read skill with path \`~/.pasture/config.json\` (or the state dir path above) to show config and confirm.`;

  let soulContent = readWorkspaceMd(dir, SOUL_MD) || readDefaultSoul();
  soulContent = soulContent ? soulContent + pathsLine : pathsLine.trim();

  let whoAmIContent = readWorkspaceMd(dir, WHO_AM_I_MD);
  const myHumanContent = readWorkspaceMd(dir, MY_HUMAN_MD);
  if (!whoAmIContent && !myHumanContent) {
    const bio = getBioFromConfig();
    const bioText = typeof bio === 'string' && (bio || '').trim() ? bio.trim() : null;
    if (bioText) whoAmIContent = bioText;
    else if (bio != null && typeof bio === 'object' && (bio.userName || bio.assistantName || bio.whoAmI || bio.whoAreYou)) {
      const parts = [];
      if (bio.userName) parts.push(`The user's name is ${bio.userName}.`);
      if (bio.assistantName) parts.push(`Your name is ${bio.assistantName}.`);
      if (bio.whoAmI) parts.push(`The user describes themselves: ${bio.whoAmI}.`);
      if (bio.whoAreYou) parts.push(`You describe yourself: ${bio.whoAreYou}.`);
      if (parts.length) whoAmIContent = parts.join(' ');
    }
  }

  let identityBlock = '';
  if (whoAmIContent || myHumanContent) {
    if (whoAmIContent) identityBlock += '\n\n' + whoAmIContent;
    if (myHumanContent) identityBlock += '\n\n' + myHumanContent;
  } else {
    const bio = getBioFromConfig();
    if (bio != null) {
      if (typeof bio === 'string' && bio.trim()) {
        identityBlock = '\n\n' + bio.trim();
      } else if (typeof bio === 'object' && (bio.userName || bio.assistantName || bio.whoAmI || bio.whoAreYou)) {
        const parts = [];
        if (bio.userName) parts.push(`The user's name is ${bio.userName}.`);
        if (bio.assistantName) parts.push(`Your name is ${bio.assistantName}.`);
        if (bio.whoAmI) parts.push(`The user describes themselves: ${bio.whoAmI}.`);
        if (bio.whoAreYou) parts.push(`You describe yourself: ${bio.whoAreYou}.`);
        if (parts.length) identityBlock = '\n\n' + parts.join(' ');
      }
    }
  }

  return soulContent + identityBlock + RUNTIME_GROUNDING_BLOCK + getGithubSystemPromptBlock() + buildLessonsBlock(dir) + timeBlock;
}

function buildLessonsBlock(workspaceDir) {
  const lessons = readWorkspaceMd(workspaceDir, LESSONS_MD);
  if (!lessons) return '';
  return '\n\n# Lessons (retrospective)\nFollow these rules learned from past mistakes:\n\n' + lessons;
}
