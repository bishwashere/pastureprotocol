/**
 * Sync GitHub setup hints for the system prompt (no API calls).
 */

import { readFileSync, existsSync } from 'fs';
import { getConfigPath, getSecretsPath, getEnvPath } from '../util/paths.js';

export function hasGithubToken() {
  if (process.env.GITHUB_TOKEN?.trim()) return true;
  try {
    const raw = readFileSync(getSecretsPath(), 'utf8');
    const secrets = JSON.parse(raw);
    if (secrets?.github?.token?.trim()) return true;
  } catch (_) {}
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    if (config?.skills?.github?.token?.trim()) return true;
  } catch (_) {}
  try {
    if (existsSync(getEnvPath())) {
      const raw = readFileSync(getEnvPath(), 'utf8');
      if (/^GITHUB_TOKEN\s*=\s*\S+/m.test(raw)) return true;
    }
  } catch (_) {}
  return false;
}

function getDefaultGithubOwner() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const explicit = config?.skills?.github?.defaultOwner?.trim();
    if (explicit) return explicit;
    const repo = config?.skills?.github?.defaultRepo?.trim();
    if (repo && repo.includes('/')) return repo.split('/')[0].trim();
  } catch (_) {}
  return null;
}

/**
 * One-line block appended to the system prompt when GitHub is configured.
 * @returns {string}
 */
export function getGithubSystemPromptBlock() {
  if (!hasGithubToken()) return '';
  const owner = getDefaultGithubOwner();
  const ownerLine = owner
    ? `Default GitHub owner from config: ${owner}. `
    : '';
  return (
    '\n\nGitHub is configured on this system (single authenticated account). ' +
    ownerLine +
    'You CAN use the GitHub skill to list repos and read files/issues/PRs that this token can access (including private repos). ' +
    'Never tell the user you lack GitHub access or that only local filesystem read is available when this block is present. ' +
    'When the user asks about "my repos", repo counts, source code on GitHub, or a project repo, use github_list_repos / github_read_file — do not ask for a GitHub username ' +
    'and do not guess owner from the user\'s real name.'
  );
}

/** User asking whether the agent can read repo / source code. */
export function isSourceCodeAccessQuestion(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bsource\s*code\b/.test(t) ||
    /\b(access|read)\b.*\b(repo|github|code)\b/.test(t) ||
    /\b(repo|github)\b.*\b(access|read|source)\b/.test(t) ||
    /\bdo you have access\b/.test(t) ||
    /\bcan you (?:read|see|access)\b.*\b(repo|code|github)\b/.test(t)
  );
}

/**
 * Intent-planner hint: load GitHub tools for source-code / repo access questions.
 * @param {string} userText
 * @param {string[]} enabledSkillIds
 */
export function getGithubSourceIntentHint(userText, enabledSkillIds, opts = {}) {
  if (!hasGithubToken() || (!opts.forceSource && !isSourceCodeAccessQuestion(userText))) return null;
  const skills = (enabledSkillIds || []).filter((id) => id === 'github');
  if (!skills.length) return null;
  return {
    mode: 'tool',
    skills,
    plan:
      'GitHub is configured. Answer using github_list_repos / github_read_file for the project repo. ' +
      'Do not claim you only have local read-only tools.',
    answer_style: 'short',
  };
}
