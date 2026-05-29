---
id: github
name: GitHub
description: GitHub integration. Read repos, list/read issues and PRs, create branches, post comments, create PRs, read files. Requires GITHUB_TOKEN in .env or skills.github.token in config.
---

# GitHub

Interact with GitHub via the REST API. Call `run_skill` with **skill: `"github"`** and **arguments.action** set to one of the actions below.

Requires a GitHub Personal Access Token (classic or fine-grained) with appropriate scopes:
- `repo` — for private repos and write operations (branches, PRs, comments)
- `public_repo` — for read-only public repo access

Set it in `~/.cowcode/.env` as `GITHUB_TOKEN=ghp_xxx`, or in `config.json` under `skills.github.token`.

---

## Actions

### `list_repos`
List repositories for the authenticated user or a specified org/user.
- **owner** (optional) — GitHub username or org (default: authenticated user)
- **type** (optional) — `all`, `owner`, `member` (default: `owner`)
- **per_page** (optional) — max results, 1–100 (default: 30)

### `read_repo`
Get details about a repository (description, stars, default branch, topics, open issues count).
- **repo** (required) — `owner/repo` (e.g. `bishwashere/cowCode`)

### `list_issues`
List issues (or pull requests) in a repository.
- **repo** (required) — `owner/repo`
- **state** (optional) — `open`, `closed`, `all` (default: `open`)
- **type** (optional) — `issues`, `prs`, `all` (default: `issues`)
- **labels** (optional) — comma-separated label names
- **per_page** (optional) — max results, 1–100 (default: 20)

### `read_issue`
Read the full body and comment thread of a single issue or PR.
- **repo** (required) — `owner/repo`
- **number** (required) — issue or PR number

### `list_prs`
List open pull requests in a repository.
- **repo** (required) — `owner/repo`
- **state** (optional) — `open`, `closed`, `all` (default: `open`)
- **per_page** (optional) — max results, 1–100 (default: 20)

### `read_file`
Read a file from a repository (returns decoded text content).
- **repo** (required) — `owner/repo`
- **path** (required) — file path in the repo (e.g. `README.md`)
- **ref** (optional) — branch, tag, or commit SHA (default: repo's default branch)

### `create_branch`
Create a new branch from an existing one.
- **repo** (required) — `owner/repo`
- **branch** (required) — new branch name (e.g. `feat/my-feature`)
- **from** (optional) — source branch/SHA (default: repo's default branch)

### `post_comment`
Post a comment on an issue or pull request.
- **repo** (required) — `owner/repo`
- **number** (required) — issue or PR number
- **body** (required) — comment text (markdown supported)

### `create_pr`
Create a pull request.
- **repo** (required) — `owner/repo`
- **title** (required) — PR title
- **head** (required) — branch with the changes (e.g. `feat/my-feature`)
- **base** (optional) — target branch (default: repo's default branch)
- **body** (optional) — PR description (markdown)
- **draft** (optional) — boolean, create as draft PR (default: false)

### `merge_pr`
Merge an open pull request.
- **repo** (required) — `owner/repo`
- **number** (required) — PR number
- **method** (optional) — `merge`, `squash`, `rebase` (default: `merge`)
- **message** (optional) — commit message (for merge/squash)

### `search_code`
Search code across GitHub.
- **query** (required) — GitHub code search query (e.g. `cowcode language:js repo:bishwashere/cowCode`)
- **per_page** (optional) — max results, 1–30 (default: 10)

---

## Usage examples

- "List open issues in bishwashere/cowCode" → action: `list_issues`, repo: `bishwashere/cowCode`
- "Show me PR #42 in myorg/myrepo" → action: `read_issue`, repo: `myorg/myrepo`, number: 42
- "Create branch feat/webhook from main in myorg/myrepo" → action: `create_branch`
- "Open a PR from feat/webhook to main" → action: `create_pr`
- "Post a comment on issue #5 in myorg/myrepo saying 'Fixed in #7'" → action: `post_comment`

Always use `owner/repo` format for the **repo** argument. Never fabricate API responses.

---

## Tool schema

```tool-schema
github_list_repos
  description: List repositories for the authenticated user or a GitHub user/org.
  parameters:
    owner: string (optional)
    type: string (optional)
    per_page: number (optional)

github_read_repo
  description: Get details about a GitHub repository.
  parameters:
    repo: string

github_list_issues
  description: List issues in a GitHub repository.
  parameters:
    repo: string
    state: string (optional)
    type: string (optional)
    labels: string (optional)
    per_page: number (optional)

github_read_issue
  description: Read a single issue or PR including comments.
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
  description: Read a file from a GitHub repository.
  parameters:
    repo: string
    path: string
    ref: string (optional)

github_create_branch
  description: Create a new branch in a GitHub repository.
  parameters:
    repo: string
    branch: string
    from: string (optional)

github_post_comment
  description: Post a comment on a GitHub issue or pull request.
  parameters:
    repo: string
    number: number
    body: string

github_create_pr
  description: Create a pull request on GitHub.
  parameters:
    repo: string
    title: string
    head: string
    base: string (optional)
    body: string (optional)
    draft: boolean (optional)

github_merge_pr
  description: Merge an open GitHub pull request.
  parameters:
    repo: string
    number: number
    method: string (optional)
    message: string (optional)

github_search_code
  description: Search code on GitHub.
  parameters:
    query: string
    per_page: number (optional)
```
