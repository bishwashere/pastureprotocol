---
id: go-write
name: Go write
description: Change the filesystem: copy, move, delete, create files and directories, chmod, rsync (local, with excludes). Commands: cp, mv, rm, touch, chmod, mkdir, rsync. Enable in config (skills.enabled).
---

# Go write

Filesystem-changing commands. Enable **go-write** in configuration (`skills.enabled`) to copy, move, delete, create files and directories, or change permissions.

Call `run_skill` with **skill: "go-write"**. Set **command** or **arguments.action** to the command name. Set **arguments.argv** to an array of arguments.

## Commands (allowlist)

- **cp** - Copy. argv: `["source", "dest"]` or `["-r", "source", "dest"]`. **Recursive directory copies** (e.g. a whole project folder) use `rsync` under the hood and **omit** dependency trees and common caches by default: `node_modules`, `.git`, `.cursor`, a **root-level** `verify/` folder (Cursor/local verification scratch), virtualenvs, `.next` / `dist` / `build` / `target`, IDE/build tool dirs, etc. **Do not** copy those unless the user clearly asks for a complete mirror. When they want **everything** (including `node_modules`, `.git`, caches), set **`fullCopy: true`** on the tool arguments, or put **`--cowcode-full-copy`** as the **first** entry in `argv` (then the usual flags and paths follow).
- **mv** - Move/rename. argv: `["source", "dest"]`
- **rm** - Remove. argv: `["path"]` or `["-r", "path"]`
- **touch** - Create empty file or update mtime. argv: `["path"]`
- **chmod** - Change mode. argv: e.g. `["755", "file"]` or `["+x", "file"]`
- **mkdir** - Create directory. argv: `["path"]` or `["-p", "a/b/c"]`
- **rsync** - **Local** directory/file tree copy with optional excludes (you can run this yourself-do not tell the user to paste a shell command unless they prefer it). argv pattern: optional short flags **only** `a`, `v`, `h`, `n` (e.g. `-a` or `-av`; `-n` = dry run), then any number of **`--exclude=PATTERN`** (must use `=`, one pattern per flag), then **exactly two** paths: **source**, **destination**. **No** remote (`user@host:` / `::`), **no** `--exclude-from`, **no** other long options. Trailing slashes on directories match normal rsync semantics (`src/` vs `src`). **When the user wants “code only, no media”**, use **rsync** with excludes-not plain `cp`. Example media-style excludes (add or drop to match their request):

  `"--exclude=*.mp4"`, `"--exclude=*.mov"`, `"--exclude=*.mkv"`, `"--exclude=*.webm"`, `"--exclude=*.wav"`, `"--exclude=*.mp3"`, `"--exclude=*.m4a"`, `"--exclude=*.png"`, `"--exclude=*.jpg"`, `"--exclude=*.jpeg"`, `"--exclude=*.gif"`, `"--exclude=*.webp"`

  Full example argv: `["-av", "--exclude=*.mp4", "--exclude=*.png", "/path/to/project/", "/path/to/dest/"]`

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: cp, mv, rm, touch, chmod, mkdir, rsync
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.
- **arguments.fullCopy** (optional) - For **`cp`** of a directory with `-r` / `-a`: if true, copy the full tree (no default excludes). Same as leading **`--cowcode-full-copy`** in `argv`.

## When to use

Use when the user asks to copy, move, delete, or create files or directories, or change permissions. For **filtered copies** (skip media, skip named globs anywhere under the tree), use **rsync** as above. Do not use for listing, disk usage, or reading-use **go-read** for that.

## Tool schema

```tool-schema
go_write_run
  description: Run a filesystem-changing command. command: cp, mv, rm, touch, chmod, mkdir, or rsync (local rsync with -a/-av and --exclude=PAT only, then src dest). argv: array of args.
  parameters:
    command: string
    argv: array
    cwd: string
```
