---
id: write
name: Write
description: Create or replace a file with given content. Wholesale write; overwrites if exists. Use when the user asks to write, create, or save a file.
---

# Write

Creates or replaces a file **wholesale**. New file: done. Existing file: overwritten. Surgical swap.

Call **run_skill** with **skill: "write"**. Set **command** or **arguments.action** to **write**.

## Arguments

- **arguments.path** (required) - File path to create or overwrite. Relative to workspace or absolute (if allowed).
- **arguments.content** (required) - Exact content to write. Replaces the entire file.

## When to use

Use when the user says things like:
- "Write hello.txt with hi world"
- "Create config.json with …"
- "Save this to notes.md"
- "Overwrite .env with …"

One path, one content. No partial updates - use the **edit** skill for find-and-replace.

## Tool schema

```tool-schema
write_file
  description: Create or overwrite a file with the given content.
  parameters:
    path: string
    content: string
```
