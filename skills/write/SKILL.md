---
id: write
name: Write
description: Create or replace a file with given content. Use whenever producing source code, configs, scaffolded projects, documents, HTML/markdown pages, or any artifact longer than a few lines — files belong on disk, not pasted into the chat. Wholesale write; overwrites if exists.
---

# Write

Creates or replaces a file **wholesale**. New file: done. Existing file: overwritten. Surgical swap.

Call **run_skill** with **skill: "write"**. Set **command** or **arguments.action** to **write**.

## Arguments

- **arguments.path** (required) - File path to create or overwrite. Relative to workspace or absolute (if allowed).
- **arguments.content** (required) - Exact content to write. Replaces the entire file.

## When to use

Use this whenever your output would be a file-worthy artifact — source code, a multi-file project, a config, a document, an HTML or markdown page, or any block longer than a few lines. Save it to disk, then reply with the path(s) and one short sentence on what was created and how to run/open it. Do not paste the artifact into the chat.

Also use when the user says things like:
- "Write hello.txt with hi world"
- "Create config.json with …"
- "Save this to notes.md"
- "Overwrite .env with …"
- "Build me a Next.js app / a script / a page" → scaffold to disk; reply with the path.

One path, one content. No partial updates - use the **edit** skill for find-and-replace.

## Tool schema

```tool-schema
write_file
  description: Create or overwrite a file with the given content.
  parameters:
    path: string
    content: string
```
