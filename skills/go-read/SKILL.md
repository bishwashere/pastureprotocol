---
id: go-read
name: Go read
description: Read and list from the filesystem only. Commands: ls, cd, pwd, cat, less, du, dashboard_url. Use for listing directories, disk usage, showing file contents, resolving paths and Pasture dashboard URLs. Enable in config (skills.enabled).
---

# Go read

Read-only filesystem commands. Enable **go-read** in configuration (`skills.enabled`) to list dirs and read files.

Call `run_skill` with **skill: "go-read"**. Set **command** or **arguments.action** to the command name. Set **arguments.argv** to an array of arguments (e.g. paths, flags).

## Commands (allowlist)

- **ls** - List directory contents. argv: e.g. `["-la"]`, `["-la", "~/Downloads"]`
- **cd** - Change directory and output the new path. argv: `["/path"]`. Returns the resolved path.
- **pwd** - Print working directory. argv: `[]`
- **cat** - Output file contents. argv: `["/path/to/file"]`
- **less** - View file (non-interactive). argv: `["/path/to/file"]` or with flags
- **du** - Disk usage. argv: e.g. `["-sh", "."]`, `["-d", "1", "path"]`
- **dashboard_url** - Resolve Pasture dashboard base URL or a route URL from process env, `~/.pasture/.env`, optional dashboard config, then source defaults. Use before probing Pasture UI routes such as `/brain`. Argument: **route** optional, e.g. `"/brain"`.

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: ls, cd, pwd, cat, less, du, dashboard_url
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.
- **arguments.route** (optional) - For dashboard_url only, a dashboard route such as `/brain`.

## When to use

Use when the user asks to list a directory, show disk usage (du), show file contents (cat/less), or resolve a path. Prefer **read** skill for reading with line ranges; use **go-read** for "list files", "what's in Downloads", "cat this file", "how big is this folder", etc.

For Pasture/CowCode self-inspection, the fixed runtime home is `~/.pasture`. When the user asks about "this project", "your code", "your source", or tells you to "check your code", list/read `~/.pasture` first. Check `~/.pasture/config.json`, `~/.pasture/workspace`, relevant logs, caches, and agent workspaces before asking the user for a path.

When the user asks about a Pasture UI route such as `/brain`, call **dashboard_url** first with that route. Then use the returned `url` for HTTP checks. Do not guess common dev ports like 3000 before resolving the dashboard URL.

## Example

List Downloads:
`run_skill` with skill: "go-read", arguments: { command: "ls", argv: ["-la", "~/Downloads"] }

## Tool schema

```tool-schema
go_read_run
  description: Run a read-only filesystem command. command: ls, cd, pwd, cat, less, or du. argv: array of args.
  parameters:
    command: string
    argv: array
    cwd: string

go_read_dashboard_url
  description: Resolve Pasture dashboard URL from process env, ~/.pasture/.env, optional dashboard config, and source defaults. Use before probing Pasture UI routes like /brain.
  parameters:
    route: string (optional)
```
