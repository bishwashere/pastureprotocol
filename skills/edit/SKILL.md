---
id: edit
name: Edit
description: Replace exact string(s) in a file. Scans, finds matches, changes only those, saves. Fails if no match. Use when the user asks to replace, change, or fix a specific string in a file.
---

# Edit

Surgical find-and-replace in a file. Scans for **exact** matches, changes only those, saves. **Fails if no match** - so you know the edit was applied.

Call **run_skill** with **skill: "edit"**. Set **command** or **arguments.action** to **edit**.

## Arguments

- **arguments.path** (required) - File to edit. Relative to workspace or absolute.
- **arguments.oldString** (required) - Exact string to find. Must match exactly (including spaces/newlines).
- **arguments.newString** (required) - String to replace it with. Use empty string to delete the match.

Prefer full absolute paths from the system root for filesystem edits. If the user gives a relative path, resolve it from the known workspace, state dir, current directory, or discovered project path before calling the tool.

## When to use

Use when the user says things like:
- "In Auth.js replace password with token"
- "Change the API URL in config to https://…"
- "Fix the typo 'teh' to 'the' in readme"

Only exact matches are replaced. If **oldString** does not appear in the file, the skill returns an error and the file is unchanged.

## Tool schema

```tool-schema
edit_file
  description: Replace exact string in a file. oldString must match exactly.
  parameters:
    path: string
    oldString: string
    newString: string
```
