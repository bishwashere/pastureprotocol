---
id: read
name: Read
description: Read a file's contents and return every line. Peek without touching. Use when the user asks to read, show, or peek at a file.
---

# Read

Grabs a file's contents and returns every line. Like **peeking without touching** - no edits, no side effects.

Call **run_skill** with **skill: "read"**. Set **command** or **arguments.action** to **read**.

## Arguments

- **arguments.path** (required) - File path to read. Can be relative to workspace (e.g. `surface/main.py`, `MEMORY.md`), absolute (e.g. `/path/to/file`), or use `~` for home (e.g. `~/.pasture/config.json`).
- **arguments.from** (optional) - Start at 1-based line number.
- **arguments.lines** (optional) - Max number of lines to return (default: all).

## When to use

Use when the user says things like:
- "Read surface main.py"
- "Show me the contents of config.json"
- "What's in MEMORY.md?"
- "Peek at index.js"
- **"Where is pasture installed?"**, **"Where is my config?"**, **"check your code"**, **"look at this project"**, or questions about Pasture/CowCode runtime features like `/brain` - start from `~/.pasture`. Read `~/.pasture/config.json` to confirm paths, then inspect the relevant `~/.pasture` state/log/workspace files. Treat state dir `~/.pasture` and workspace `~/.pasture/workspace` as fixed defaults unless config says otherwise.
- "What's in my config?" / "Show me my config" - use read with path `~/.pasture/config.json`.

For SQLite database inspection or row counts, use **go-read** with action `sql`; `read` is only for file contents.

The skill returns the file content as text. No modifications are made.

## Tool schema

```tool-schema
read_file
  description: Read a file's contents. Path required; optional from (line) and lines (count).
  parameters:
    path: string
    from: number
    lines: number
```
