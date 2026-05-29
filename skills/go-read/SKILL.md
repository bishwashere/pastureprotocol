---
id: go-read
name: Go read
description: Read and list from the filesystem only. Commands: ls, cd, pwd, cat, less, du. Use for listing directories, disk usage, showing file contents, resolving paths. Enable in config (skills.enabled).
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

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: ls, cd, pwd, cat, less, du
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.

## When to use

Use when the user asks to list a directory, show disk usage (du), show file contents (cat/less), or resolve a path. Prefer **read** skill for reading with line ranges; use **go-read** for "list files", "what's in Downloads", "cat this file", "how big is this folder", etc.

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
```
