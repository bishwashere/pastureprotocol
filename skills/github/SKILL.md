---
id: github
name: GitHub
description: GitHub integration. Read repos, list/read issues and PRs, create branches, post comments, create PRs. Requires GitHub token in ~/.pasture/secrets.json or GITHUB_TOKEN env var.
---

# GitHub

Interact with GitHub via the REST API. Read repositories, issues, PRs, and files. Create branches, post comments, open PRs, merge PRs.

---

## Setup (required before first use)

1. Create a GitHub Personal Access Token at https://github.com/settings/tokens
   - **Read-only** (repos, issues, PRs): select scope `public_repo` (public) or `repo` (private)
   - **Write** (create branch, post comment, open PR): scope `repo`
   - **Minimum recommended scopes:** `repo`, `issues`, `pull_requests`
   - **Never** grant `admin:org`, `delete_repo`, or `workflow` unless you explicitly need them

2. Save the token in `~/.pasture/secrets.json` (gitignored, never committed):
   ```json
   { "github": { "token": "ghp_your_token_here" } }
   ```
   Or set `GITHUB_TOKEN` in `~/.pasture/.env`.

3. (Optional) Set a default repo in `config.json` so you don't repeat it each time:
   ```json
   "skills": { "github": { "defaultRepo": "owner/repo" } }
   ```

---

## Actions

### `list_repos`
List repositories for the authenticated user or a specified org/user.
- **owner** (optional) - GitHub username or org. **Omit for the authenticated token account** — this is the default for "my repos", "how many repos do I have", etc. Do **not** use `@me` and do **not** guess owner from the user's real name (e.g. do not pass `bishwasmishra` unless that is their GitHub login).
- **type** (optional) - `all`, `owner`, `member` (default: `all` for full repo counts)
- **per_page** (optional) - page size, 1–100 (default: 100)
- **paginate** (optional) - when true (default), fetches all pages so `count` is the total

Returns `{ authenticated_as, owner, count, repos }`. Use `count` directly when the user asks how many repos they have.

**Single-account setup:** if only one GitHub token is configured, that account IS the answer — never ask the user for their GitHub username.

### `read_repo`
Get details about a repository (description, stars, default branch, topics, open issue count).
- **repo** (required) - `owner/repo`

### `list_issues`
List issues or pull requests in a repository.
- **repo** (required) - `owner/repo`
- **state** (optional) - `open`, `closed`, `all` (default: `open`)
- **type** (optional) - `issues`, `prs`, `all` (default: `issues`)
- **labels** (optional) - comma-separated label names to filter by
- **per_page** (optional) - max results (default: 20)

### `read_issue`
Read the full body and comment thread of a single issue or PR.
- **repo** (required) - `owner/repo`
- **number** (required) - issue or PR number

### `list_prs`
List pull requests in a repository.
- **repo** (required) - `owner/repo`
- **state** (optional) - `open`, `closed`, `all` (default: `open`)
- **per_page** (optional) - max results (default: 20)

### `read_file`
Read a file from a repository (returns decoded text content). Avoid reading large binary files.
- **repo** (required) - `owner/repo`
- **path** (required) - file path in the repo (e.g. `README.md`)
- **ref** (optional) - branch, tag, or commit SHA (default: repo default branch)

### `create_branch` ⚠️ requires confirm
Create a new branch from an existing one.
- **repo** (required) - `owner/repo`
- **branch** (required) - new branch name (e.g. `feat/my-feature`)
- **from** (optional) - source branch or commit SHA (default: repo default branch)
- **confirm** (required) - must be `true` to proceed

### `post_comment` ⚠️ requires confirm
Post a comment on an issue or pull request.
- **repo** (required) - `owner/repo`
- **number** (required) - issue or PR number
- **body** (required) - comment text (markdown supported)
- **confirm** (required) - must be `true` to proceed

### `create_pr` ⚠️ requires confirm
Open a pull request.
- **repo** (required) - `owner/repo`
- **title** (required) - PR title
- **head** (required) - branch with the changes (e.g. `feat/my-feature`)
- **base** (optional) - target branch (default: repo default branch)
- **body** (optional) - PR description (markdown)
- **draft** (optional) - boolean, create as draft PR (default: false)
- **confirm** (required) - must be `true` to proceed

### `merge_pr` ⚠️ requires confirm (irreversible)
Merge an open pull request.
- **repo** (required) - `owner/repo`
- **number** (required) - PR number
- **method** (optional) - `merge`, `squash`, `rebase` (default: `merge`)
- **message** (optional) - commit message (for merge/squash)
- **confirm** (required) - must be `true` to proceed (always show user PR title and target branch first)

### `search_code`
Search code across GitHub.
- **query** (required) - GitHub code search query (e.g. `pastureprotocol language:js repo:owner/repo`)
- **per_page** (optional) - max results, 1–30 (default: 10)

---

## Natural language examples

| User says | Action |
|---|---|
| "How many repos do I have?" / "total repos" | `list_repos` — **omit owner**, type `all` — reply with `count` |
| "List my GitHub repos" | `list_repos` — omit owner |
| "List open issues in myorg/myrepo" | `list_issues` |
| "Show me PR #42" | `read_issue` number: 42 |
| "What PRs are open?" | `list_prs` |
| "Read the README from main branch" | `read_file` path: README.md |
| "Create branch feat/webhook from main" | `create_branch` (ask confirm) |
| "Open a PR from feat/webhook to main titled 'Add webhooks'" | `create_pr` (ask confirm) |
| "Post a comment on issue #5 saying 'Fixed in #8'" | `post_comment` (ask confirm) |
| "Merge PR #10 with squash" | `merge_pr` method: squash (ask confirm, show PR details first) |
| "Search for 'executeGithub' in my repo" | `search_code` |

---

## Privacy & Safety

- **Never** save raw GitHub file contents or issue bodies to `MEMORY.md` unless the user explicitly asks.
- **Scope tokens to minimum necessary.** Prefer fine-grained tokens with specific repo + permission access.
- **Confirmation is required** for all write actions. Always show what will happen before calling with `confirm: true`.
- Confirmed write actions return a `verification` object from a GitHub read-back. Do not tell the user a branch, comment, PR, or merge is complete if `verification.verified` is not true; retry when appropriate or say the change was not verified.
- For `merge_pr`, always display the PR title and target branch to the user before confirming.

---

## Tool schema

```tool-schema
github_list_repos
  description: List repositories for the authenticated GitHub token account (omit owner) or for a specific user/org. Returns count and repos. For "my repos" or repo totals, omit owner — do not ask for username.
  parameters:
    owner: string (optional)
    type: string (optional)
    per_page: number (optional)
    paginate: boolean (optional)

github_read_repo
  description: Get details about a GitHub repository.
  parameters:
    repo: string

github_list_issues
  description: List issues or pull requests in a GitHub repository.
  parameters:
    repo: string
    state: string (optional)
    type: string (optional)
    labels: string (optional)
    per_page: number (optional)

github_read_issue
  description: Read a single issue or PR including all comments.
  parameters:
    repo: string
    number: number

github_list_prs
  description: List pull requests in a GitHub repository.
  parameters:
    repo: string
    state: string (optional)
    per_page: number (optional)

github_read_file
  description: Read a file from a GitHub repository (decoded text content).
  parameters:
    repo: string
    path: string
    ref: string (optional)

github_create_branch
  description: Create a new branch in a GitHub repository. Requires confirm=true.
  parameters:
    repo: string
    branch: string
    from: string (optional)
    confirm: boolean

github_post_comment
  description: Post a comment on a GitHub issue or pull request. Requires confirm=true.
  parameters:
    repo: string
    number: number
    body: string
    confirm: boolean

github_create_pr
  description: Create a pull request on GitHub. Requires confirm=true.
  parameters:
    repo: string
    title: string
    head: string
    base: string (optional)
    body: string (optional)
    draft: boolean (optional)
    confirm: boolean

github_merge_pr
  description: Merge an open GitHub pull request. Irreversible - always show PR details to user first. Requires confirm=true.
  parameters:
    repo: string
    number: number
    method: string (optional)
    message: string (optional)
    confirm: boolean

github_search_code
  description: Search code on GitHub.
  parameters:
    query: string
    per_page: number (optional)
```
