/**
 * GitHub executor: GitHub REST API via fetch.
 * Token read from GITHUB_TOKEN env var or config.skills.github.token.
 * Actions: list_repos, read_repo, list_issues, read_issue, list_prs,
 *          read_file, create_branch, post_comment, create_pr, merge_pr, search_code.
 */

import { readFileSync, existsSync } from 'fs';
import { getConfigPath } from '../paths.js';

const BASE = 'https://api.github.com';
const MAX_BODY_CHARS = 12_000;

function truncate(s, max = MAX_BODY_CHARS) {
  const t = String(s || '').trim();
  return t.length <= max ? t : t.slice(0, max) + '\n…(truncated)';
}

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const t = config?.skills?.github?.token;
    if (t && typeof t === 'string' && t.trim()) return t.trim();
  } catch (_) {}
  return null;
}

function getDefaultRepo() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    return config?.skills?.github?.defaultRepo?.trim() || null;
  } catch (_) { return null; }
}

async function ghFetch(path, { method = 'GET', body = null, token } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cowCode/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) {
    opts.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json?.message || text || `HTTP ${res.status}`;
    throw new Error(`GitHub API error ${res.status}: ${msg}`);
  }
  return json;
}

function parseRepo(repo) {
  if (!repo || typeof repo !== 'string' || !repo.includes('/')) {
    throw new Error('repo must be "owner/repo" format (e.g. "bishwashere/cowCode")');
  }
  const [owner, name] = repo.trim().split('/');
  return { owner, name };
}

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

/**
 * @param {object} ctx
 * @param {object} args
 * @param {string} toolName - e.g. github_list_repos
 */
export async function executeGithub(ctx, args, toolName) {
  const token = getToken();
  if (!token) {
    return JSON.stringify({
      error: 'GitHub token not configured. Set GITHUB_TOKEN in ~/.cowcode/.env or skills.github.token in config.json.',
    });
  }

  const action = (toolName || '').replace(/^github_/, '') || (args?.action && String(args.action).trim());
  if (!action) return JSON.stringify({ error: 'action required' });

  const gh = (path, opts = {}) => ghFetch(path, { ...opts, token });

  try {
    switch (action) {

      case 'list_repos': {
        const owner = args?.owner?.trim();
        const type = args?.type?.trim() || 'owner';
        const per_page = Math.min(100, Math.max(1, Number(args?.per_page) || 30));
        const path = owner
          ? `/users/${encodeURIComponent(owner)}/repos?type=${type}&per_page=${per_page}&sort=updated`
          : `/user/repos?type=${type}&per_page=${per_page}&sort=updated`;
        const data = await gh(path);
        return JSON.stringify((data || []).map(formatRepo));
      }

      case 'read_repo': {
        const { owner, name } = parseRepo(args?.repo);
        const data = await gh(`/repos/${owner}/${name}`);
        return JSON.stringify(formatRepo(data));
      }

      case 'list_issues': {
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
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
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const num = Number(args?.number);
        if (!num) throw new Error('number required');
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
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const state = args?.state?.trim() || 'open';
        const per_page = Math.min(100, Math.max(1, Number(args?.per_page) || 20));
        const data = await gh(`/repos/${owner}/${name}/pulls?state=${state}&per_page=${per_page}&sort=updated`);
        return JSON.stringify((data || []).map(formatIssue));
      }

      case 'read_file': {
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const filePath = args?.path?.trim();
        if (!filePath) throw new Error('path required');
        const ref = args?.ref?.trim() || '';
        const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
        const data = await gh(`/repos/${owner}/${name}/contents/${filePath}${query}`);
        if (data.encoding === 'base64' && data.content) {
          const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
          return JSON.stringify({ path: data.path, sha: data.sha, content: truncate(decoded) });
        }
        if (data.type === 'dir') {
          return JSON.stringify({ path: data.path, type: 'dir', entries: data.map?.((e) => ({ name: e.name, type: e.type, size: e.size })) });
        }
        return JSON.stringify(data);
      }

      case 'create_branch': {
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const branch = args?.branch?.trim();
        if (!branch) throw new Error('branch required');
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
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const num = Number(args?.number);
        if (!num) throw new Error('number required');
        const body = args?.body?.trim();
        if (!body) throw new Error('body required');
        const result = await gh(`/repos/${owner}/${name}/issues/${num}/comments`, {
          method: 'POST',
          body: { body },
        });
        return JSON.stringify({ id: result.id, url: result.html_url });
      }

      case 'create_pr': {
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const title = args?.title?.trim();
        const head = args?.head?.trim();
        if (!title) throw new Error('title required');
        if (!head) throw new Error('head (source branch) required');
        const base = args?.base?.trim() || (await gh(`/repos/${owner}/${name}`)).default_branch;
        const result = await gh(`/repos/${owner}/${name}/pulls`, {
          method: 'POST',
          body: {
            title,
            head,
            base,
            body: args?.body?.trim() || '',
            draft: args?.draft === true || args?.draft === 'true',
          },
        });
        return JSON.stringify({
          number: result.number,
          title: result.title,
          url: result.html_url,
          state: result.state,
        });
      }

      case 'merge_pr': {
        const { owner, name } = parseRepo(args?.repo || getDefaultRepo());
        const num = Number(args?.number);
        if (!num) throw new Error('number required');
        const method = args?.method?.trim() || 'merge';
        const result = await gh(`/repos/${owner}/${name}/pulls/${num}/merge`, {
          method: 'PUT',
          body: {
            merge_method: method,
            commit_message: args?.message?.trim() || '',
          },
        });
        return JSON.stringify({ merged: result.merged, sha: result.sha, message: result.message });
      }

      case 'search_code': {
        const query = args?.query?.trim();
        if (!query) throw new Error('query required');
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

      default:
        return JSON.stringify({ error: `Unknown GitHub action: ${action}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
