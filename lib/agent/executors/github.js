/**
 * GitHub executor: GitHub REST API via fetch.
 *
 * Token priority:
 *   1. GITHUB_TOKEN env var
 *   2. ~/.pasture/secrets.json → secrets.github.token  (preferred for security)
 *   3. config.json → skills.github.token  (legacy fallback — warns on use)
 *
 * Destructive actions (create_branch, create_pr, merge_pr, post_comment) require confirm: true.
 * Retry with exponential backoff on 429 and 5xx responses (up to 3 retries).
 *
 * Actions: list_repos, read_repo, list_issues, read_issue, list_prs,
 *          read_file, create_branch, post_comment, create_pr, merge_pr, search_code.
 */

import { readFileSync } from 'fs';
import { getConfigPath, getSecretsPath } from '../paths.js';
import { normalizeSelfAlias } from '../credential-utils.js';

const BASE = 'https://api.github.com';
const MAX_BODY_CHARS = 12_000;
const MAX_RETRIES = 3;

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s, max = MAX_BODY_CHARS) {
  const t = String(s || '').trim();
  return t.length <= max ? t : t.slice(0, max) + '\n…(truncated)';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function friendlyError(status, message) {
  const base = message || `GitHub API error ${status}`;
  if (status === 401) return `GitHub authentication failed (${base}). Check your token — it may have expired or have insufficient scopes.`;
  if (status === 403) {
    if (/rate limit/i.test(base)) return `GitHub rate limit hit. Please wait a moment and try again. (${base})`;
    return `GitHub permission denied (${base}). Your token may lack required scopes (repo, issues, pull_requests).`;
  }
  if (status === 404) {
    if (/\/users\//.test(base) || /\/repos\//.test(base)) {
      return `GitHub resource not found (${base}). Check the username, repo name, or issue/PR number. For your own repos, use list_repos with no owner (do not use @me).`;
    }
    return `GitHub resource not found (${base}). Check the repo name, issue number, or branch.`;
  }
  if (status === 409) return `GitHub conflict (${base}). The branch may already exist or the PR may already be merged.`;
  if (status === 422) return `GitHub rejected the request (${base}). Check that all required fields are valid.`;
  if (status >= 500) return `GitHub server error ${status}: ${base}. Try again in a moment.`;
  return `GitHub error ${status}: ${base}`;
}

async function ghFetch(path, { method = 'GET', body = null, token } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pastureprotocol/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.random() * 200;
      await sleep(wait);
    }
    let res;
    try {
      res = await fetch(url, opts);
    } catch (networkErr) {
      lastErr = new Error(`GitHub network error: ${networkErr.message}`);
      if (attempt < MAX_RETRIES) continue;
      throw lastErr;
    }
    // Retry on rate-limit or server errors (GET/HEAD only; don't retry mutations)
    if ((res.status === 429 || res.status >= 500) && (method === 'GET' || method === 'HEAD') && attempt < MAX_RETRIES) {
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) await sleep(Number(retryAfter) * 1000);
      lastErr = new Error(friendlyError(res.status, `retrying (attempt ${attempt + 1})`));
      continue;
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
    if (!res.ok) throw new Error(friendlyError(res.status, json?.message || text));
    return json;
  }
  throw lastErr || new Error('GitHub request failed after retries');
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    if (!/rel="next"/.test(part)) continue;
    const m = part.match(/<([^>]+)>/);
    if (!m) continue;
    const url = m[1];
    return url.startsWith(BASE) ? url.slice(BASE.length) : url;
  }
  return null;
}

async function ghFetchPage(path, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pastureprotocol/1.0',
    Authorization: `Bearer ${token}`,
  };
  const url = path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? path : '/' + path}`;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  if (!res.ok) throw new Error(friendlyError(res.status, json?.message || text));
  return { data: json, nextPath: parseNextLink(res.headers.get('link')) };
}

async function ghFetchArrayPaginated(path, token, maxPages = 10) {
  const all = [];
  let nextPath = path;
  for (let i = 0; i < maxPages && nextPath; i++) {
    const page = await ghFetchPage(nextPath, token);
    if (!Array.isArray(page.data)) return page.data;
    all.push(...page.data);
    nextPath = page.nextPath;
  }
  return all;
}

// ── Token resolution ──────────────────────────────────────────────────────────

let _warnedConfigToken = false;

function getToken() {
  // 1. Env var (most flexible — works in CI, launchd, etc.)
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN.trim(), source: 'env' };

  // 2. secrets.json (preferred storage — gitignored, 0600 permissions)
  try {
    const raw = readFileSync(getSecretsPath(), 'utf8');
    const secrets = JSON.parse(raw);
    const t = secrets?.github?.token;
    if (t && typeof t === 'string' && t.trim()) return { token: t.trim(), source: 'secrets' };
  } catch (_) {}

  // 3. config.json fallback (legacy — warn once to nudge migration)
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const t = config?.skills?.github?.token;
    if (t && typeof t === 'string' && t.trim()) {
      if (!_warnedConfigToken) {
        _warnedConfigToken = true;
        console.warn('[github] Token found in config.json. For better security, move it to ~/.pasture/secrets.json: { "github": { "token": "ghp_..." } }');
      }
      return { token: t.trim(), source: 'config' };
    }
  } catch (_) {}

  return { token: null, source: null };
}

function getDefaultRepo() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const r = config?.skills?.github?.defaultRepo?.trim();
    return r || null;
  } catch (_) { return null; }
}

function parseRepo(repoArg) {
  const explicit = (repoArg || '').trim();
  const repo = explicit || getDefaultRepo() || '';
  if (!repo.includes('/')) {
    if (explicit && normalizeSelfAlias(explicit) === '') {
      throw new Error('Use list_repos (omit repo) to list your repositories. read_repo and other repo actions require owner/repo format.');
    }
    throw new Error('repo must be "owner/repo" format (e.g. "acme/my-project"). Set a defaultRepo in config.json to skip this each time.');
  }
  const [owner, name] = repo.split('/');
  return { owner: owner.trim(), name: name.trim() };
}

/** LLMs often pass "@me" — GitHub uses GET /user/repos for the authenticated user. */
function normalizeListReposOwner(ownerArg) {
  return normalizeSelfAlias(ownerArg);
}

// ── Formatters ───────────────────────────────────────────────────────────────

function formatRepo(r) {
  return {
    full_name: r.full_name,
    description: r.description || '',
    private: r.private,
    default_branch: r.default_branch,
    stars: r.stargazers_count,
    forks: r.forks_count,
    open_issues: r.open_issues_count,
    url: r.html_url,
    topics: r.topics || [],
    language: r.language || null,
    pushed_at: r.pushed_at,
  };
}

function formatIssue(i) {
  return {
    number: i.number,
    title: i.title,
    state: i.state,
    type: i.pull_request ? 'pr' : 'issue',
    author: i.user?.login,
    labels: (i.labels || []).map((l) => l.name),
    created_at: i.created_at,
    updated_at: i.updated_at,
    url: i.html_url,
    body: truncate(i.body || '', 2000),
  };
}

function formatComment(c) {
  return {
    author: c.user?.login,
    created_at: c.created_at,
    body: truncate(c.body || '', 1000),
    url: c.html_url,
  };
}

// ── Confirmation guard ────────────────────────────────────────────────────────

/**
 * Build a confirmation-required response with a clear description of what will happen.
 * The agent should present this to the user verbatim before retrying with confirm: true.
 */
function needsConfirm(details) {
  return JSON.stringify({
    error: 'confirmation_required',
    message: `Confirmation required before proceeding. Here is what will happen:\n\n${details}\n\nAsk the user to confirm, then call this action again with confirm: true.`,
  });
}

// ── Main executor ─────────────────────────────────────────────────────────────

/**
 * @param {object} ctx
 * @param {object} args
 * @param {string} toolName - e.g. github_list_repos
 */
export async function executeGithub(ctx, args, toolName) {
  const { token } = getToken();
  if (!token) {
    return JSON.stringify({
      error: 'GitHub token not configured.',
      setup: [
        '1. Create a token at https://github.com/settings/tokens',
        '   • For read-only access: scope "public_repo"',
        '   • For full repo access: scope "repo"',
        '   • For PRs and issues: scope "repo" or fine-grained "Issues" + "Pull requests"',
        '   • Minimum recommended: repo, issues, pull_requests (avoid admin/webhook scopes)',
        '2. Save it in ~/.pasture/secrets.json: { "github": { "token": "ghp_..." } }',
        '   (Never commit secrets.json — it is gitignored)',
        '3. Or set GITHUB_TOKEN env var in ~/.pasture/.env',
      ].join('\n'),
    });
  }

  const action = (toolName || '').replace(/^github_/, '') || (args?.action && String(args.action).trim());
  if (!action) return JSON.stringify({ error: 'action required' });

  const gh = (path, opts = {}) => ghFetch(path, { ...opts, token });

  try {
    switch (action) {

      // ── Read operations ───────────────────────────────────────────────────

      case 'list_repos': {
        const ownerArg = normalizeListReposOwner(args?.owner);
        const type = args?.type?.trim() || 'all';
        const per_page = Math.min(100, Math.max(1, Number(args?.per_page) || 100));
        const paginate = args?.paginate !== false && args?.paginate !== 'false';

        async function listFor(owner) {
          const path = owner
            ? `/users/${encodeURIComponent(owner)}/repos?type=${type}&per_page=${per_page}&sort=updated`
            : `/user/repos?type=${type}&per_page=${per_page}&sort=updated`;
          if (paginate) return ghFetchArrayPaginated(path, token);
          return gh(path);
        }

        let authLogin = null;
        try {
          const me = await gh('/user');
          authLogin = me?.login || null;
        } catch (_) {}

        let repos;
        let ownerUsed = ownerArg || authLogin || null;
        let fallbackToAuthenticated = false;
        try {
          repos = await listFor(ownerArg);
        } catch (err) {
          if (ownerArg && /not found|404/i.test(err.message || '')) {
            repos = await listFor('');
            ownerUsed = authLogin;
            fallbackToAuthenticated = true;
          } else {
            throw err;
          }
        }

        const list = Array.isArray(repos) ? repos : [];
        return JSON.stringify({
          authenticated_as: authLogin,
          owner: ownerUsed,
          count: list.length,
          fallback_to_authenticated: fallbackToAuthenticated,
          repos: list.map(formatRepo),
        });
      }

      case 'read_repo': {
        const { owner, name } = parseRepo(args?.repo);
        const data = await gh(`/repos/${owner}/${name}`);
        return JSON.stringify(formatRepo(data));
      }

      case 'list_issues': {
        const { owner, name } = parseRepo(args?.repo);
        const state = args?.state?.trim() || 'open';
        const type = (args?.type?.trim() || 'issues').toLowerCase();
        const labels = args?.labels?.trim() || '';
        const per_page = Math.min(100, Math.max(1, Number(args?.per_page) || 20));
        let path = `/repos/${owner}/${name}/issues?state=${state}&per_page=${per_page}&sort=updated`;
        if (labels) path += `&labels=${encodeURIComponent(labels)}`;
        const data = await gh(path);
        const filtered = type === 'prs'
          ? data.filter((i) => i.pull_request)
          : type === 'issues'
            ? data.filter((i) => !i.pull_request)
            : data;
        return JSON.stringify(filtered.map(formatIssue));
      }

      case 'read_issue': {
        const { owner, name } = parseRepo(args?.repo);
        const num = Number(args?.number);
        if (!num) throw new Error('number required (issue or PR number)');
        const [issue, comments] = await Promise.all([
          gh(`/repos/${owner}/${name}/issues/${num}`),
          gh(`/repos/${owner}/${name}/issues/${num}/comments?per_page=50`),
        ]);
        return JSON.stringify({
          ...formatIssue(issue),
          comments: (comments || []).map(formatComment),
        });
      }

      case 'list_prs': {
        const { owner, name } = parseRepo(args?.repo);
        const state = args?.state?.trim() || 'open';
        const per_page = Math.min(100, Math.max(1, Number(args?.per_page) || 20));
        const data = await gh(`/repos/${owner}/${name}/pulls?state=${state}&per_page=${per_page}&sort=updated`);
        return JSON.stringify((data || []).map(formatIssue));
      }

      case 'read_file': {
        const { owner, name } = parseRepo(args?.repo);
        const filePath = args?.path?.trim();
        if (!filePath) throw new Error('path required (e.g. "README.md" or "src/index.js")');
        const ref = args?.ref?.trim() || '';
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        const data = await gh(`/repos/${owner}/${name}/contents/${filePath}${query}`);
        if (Array.isArray(data)) {
          return JSON.stringify({ path: filePath, type: 'dir', entries: data.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path })) });
        }
        if (data.encoding === 'base64' && data.content) {
          const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
          return JSON.stringify({ path: data.path, sha: data.sha, content: truncate(decoded) });
        }
        return JSON.stringify(data);
      }

      case 'search_code': {
        const query = args?.query?.trim();
        if (!query) throw new Error('query required (GitHub code search syntax, e.g. "pasture language:js")');
        const per_page = Math.min(30, Math.max(1, Number(args?.per_page) || 10));
        const data = await gh(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
        return JSON.stringify({
          total_count: data.total_count,
          items: (data.items || []).map((i) => ({
            path: i.path,
            repo: i.repository?.full_name,
            url: i.html_url,
            sha: i.sha,
          })),
        });
      }

      // ── Write operations (all require confirm: true) ──────────────────────

      case 'create_branch': {
        const { owner, name } = parseRepo(args?.repo);
        const branch = args?.branch?.trim();
        if (!branch) throw new Error('branch required (new branch name, e.g. "feat/my-feature")');

        if (args?.confirm !== true) {
          const from = args?.from?.trim() || '(repo default branch)';
          return needsConfirm(
            `Create branch "${branch}" from "${from}" in ${owner}/${name}.\n` +
            `This will create a new branch in the remote repository.`
          );
        }

        const from = args?.from?.trim();
        let sha;
        if (from && /^[0-9a-f]{40}$/i.test(from)) {
          sha = from;
        } else {
          const srcBranch = from || (await gh(`/repos/${owner}/${name}`)).default_branch;
          const ref = await gh(`/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(srcBranch)}`);
          sha = ref.object.sha;
        }
        const result = await gh(`/repos/${owner}/${name}/git/refs`, {
          method: 'POST',
          body: { ref: `refs/heads/${branch}`, sha },
        });
        return JSON.stringify({ created: branch, sha: result.object?.sha, url: result.url });
      }

      case 'post_comment': {
        const { owner, name } = parseRepo(args?.repo);
        const num = Number(args?.number);
        if (!num) throw new Error('number required (issue or PR number)');
        const body = args?.body?.trim();
        if (!body) throw new Error('body required (comment text)');

        if (args?.confirm !== true) {
          return needsConfirm(
            `Post a comment on ${owner}/${name}#${num}:\n\n"${truncate(body, 300)}"\n\n` +
            `This will be publicly visible.`
          );
        }

        const result = await gh(`/repos/${owner}/${name}/issues/${num}/comments`, {
          method: 'POST',
          body: { body },
        });
        return JSON.stringify({ id: result.id, url: result.html_url });
      }

      case 'create_pr': {
        const { owner, name } = parseRepo(args?.repo);
        const title = args?.title?.trim();
        const head = args?.head?.trim();
        if (!title) throw new Error('title required (PR title)');
        if (!head) throw new Error('head required (source branch with your changes, e.g. "feat/my-feature")');

        const base = args?.base?.trim() || '';
        const isDraft = args?.draft === true || args?.draft === 'true';
        const prBody = args?.body?.trim() || '';

        if (args?.confirm !== true) {
          return needsConfirm(
            `Create a${isDraft ? ' draft' : ''} pull request in ${owner}/${name}:\n` +
            `  Title: "${title}"\n` +
            `  From:  ${head}\n` +
            `  Into:  ${base || '(repo default branch)'}\n` +
            (prBody ? `  Body:  "${truncate(prBody, 200)}"\n` : '') +
            `\nThis will open a PR on GitHub.`
          );
        }

        const repoData = await gh(`/repos/${owner}/${name}`);
        const mergeBase = base || repoData.default_branch;
        const result = await gh(`/repos/${owner}/${name}/pulls`, {
          method: 'POST',
          body: { title, head, base: mergeBase, body: prBody, draft: isDraft },
        });
        return JSON.stringify({
          number: result.number,
          title: result.title,
          url: result.html_url,
          state: result.state,
        });
      }

      case 'merge_pr': {
        const { owner, name } = parseRepo(args?.repo);
        const num = Number(args?.number);
        if (!num) throw new Error('number required (PR number to merge)');

        // Extra caution: always fetch PR details to show in the confirmation
        const prData = await gh(`/repos/${owner}/${name}/pulls/${num}`);
        const method = args?.method?.trim() || 'merge';

        if (args?.confirm !== true) {
          return needsConfirm(
            `MERGE pull request ${owner}/${name}#${num}: "${prData.title}"\n` +
            `  From: ${prData.head?.ref} → ${prData.base?.ref}\n` +
            `  Method: ${method}\n` +
            `  Author: ${prData.user?.login}\n` +
            `\nThis is IRREVERSIBLE — the PR will be merged into ${prData.base?.ref}.`
          );
        }

        const result = await gh(`/repos/${owner}/${name}/pulls/${num}/merge`, {
          method: 'PUT',
          body: {
            merge_method: method,
            commit_message: args?.message?.trim() || '',
          },
        });
        return JSON.stringify({ merged: result.merged, sha: result.sha, message: result.message });
      }

      default:
        return JSON.stringify({ error: `Unknown GitHub action: "${action}". Valid actions: list_repos, read_repo, list_issues, read_issue, list_prs, read_file, create_branch, post_comment, create_pr, merge_pr, search_code.` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
