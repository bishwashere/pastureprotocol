/**
 * Load group.md (criteria and messages for group chat). No code-based group conditions —
 * all criteria are in the file; we only load and substitute placeholders.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_GROUP_MD_DIR = join(__dirname, '..', 'workspace-default');

/**
 * Parse YAML-like front matter (--- ... ---) and return key-value pairs.
 * @param {string} content
 * @returns {{ [key: string]: string }}
 */
function parseFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !key.startsWith('#')) out[key] = value;
  }
  return out;
}

/**
 * Parse ## section_name and content. Returns { section_name: "content", ... }.
 * @param {string} body - Content after front matter
 * @returns {{ [key: string]: string }}
 */
function parseSections(body) {
  const sections = {};
  const parts = body.split(/\n##\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const firstNewline = part.indexOf('\n');
    const name = firstNewline === -1 ? part : part.slice(0, firstNewline).trim().replace(/\s+/g, '_');
    const content = firstNewline === -1 ? '' : part.slice(firstNewline + 1).trim();
    if (name) sections[name] = content;
  }
  return sections;
}

/**
 * Load group.md from workspace first, then default dir. Returns sections and messages for group prompt.
 * @param {string} workspaceDir - e.g. getWorkspaceDir()
 * @param {string} [defaultDir] - e.g. join(INSTALL_DIR, 'workspace-default'). If omitted, uses repo workspace-default.
 * @returns {{ sections: { paths?: string, group_context?: string, reply_when_mentioned?: string, reply_when_not_mentioned?: string, non_owner_restrictions?: string }, messages: { rate_limit_message?: string, cron_not_allowed_message?: string, scan_not_allowed_message?: string } }}
 */
export function loadGroupMd(workspaceDir, defaultDir = DEFAULT_GROUP_MD_DIR) {
  const workspacePath = join(workspaceDir, 'group.md');
  const defaultPath = join(defaultDir, 'group.md');
  const path = existsSync(workspacePath) ? workspacePath : defaultPath;
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch (_) {
    return { sections: {}, messages: {} };
  }
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const body = fmMatch ? raw.slice(fmMatch[0].length).trim() : raw;
  const messages = parseFrontMatter(raw);
  const sections = parseSections(body);
  return {
    sections: {
      paths: sections.paths ?? '',
      group_context: sections.group_context ?? '',
      reply_when_mentioned: sections.reply_when_mentioned ?? '',
      reply_when_not_mentioned: sections.reply_when_not_mentioned ?? '',
      when_to_reply: sections.when_to_reply ?? '',
      when_only_at_bot: sections.when_only_at_bot ?? '',
      non_owner_restrictions: sections.non_owner_restrictions ?? '',
    },
    messages: {
      rate_limit_message: messages.rate_limit_message ?? "Too many requests from this group. Please wait a minute or ask the bot owner.",
      cron_not_allowed_message: messages.cron_not_allowed_message ?? "Cron jobs are not allowed for group members.",
      scan_not_allowed_message: messages.scan_not_allowed_message ?? "Scanning is not allowed for group members.",
    },
  };
}

/**
 * Build the group block for the system prompt from loaded sections.
 * @param {{ sections: object, messages: object }} loaded - From loadGroupMd
 * @param {{ groupSenderName: string, groupMentioned: boolean, groupNonOwner?: boolean }} opts
 * @returns {string}
 */
export function buildGroupPromptBlock(loaded, opts) {
  const { sections } = loaded;
  const senderName = opts.groupSenderName || 'A group member';
  let out = '';
  if (sections.paths) out += '\n\n' + sections.paths;
  if (sections.group_context) {
    out += '\n\n' + sections.group_context.replace(/\{\{groupSenderName\}\}/g, senderName);
  }
  if (sections.when_to_reply) {
    out += '\n\n' + sections.when_to_reply;
    if (sections.when_only_at_bot) out += '\n\n' + sections.when_only_at_bot;
  } else if (opts.groupMentioned && sections.reply_when_mentioned) {
    out += '\n\n' + sections.reply_when_mentioned;
  } else if (!opts.groupMentioned && sections.reply_when_not_mentioned) {
    out += '\n\n' + sections.reply_when_not_mentioned;
  }
  if (opts.groupNonOwner && sections.non_owner_restrictions) {
    out += '\n\n' + sections.non_owner_restrictions;
  }
  return out.trim();
}
