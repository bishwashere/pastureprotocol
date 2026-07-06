---
id: apply-patch
name: Apply patch
description: Apply a Git-style diff hunk to a file. Feed a diff hunk (plus new line, minus remove). Use when the user wants to apply a patch or diff.
---

# Apply Patch

Git-style **patch applicator**. You feed it a **diff hunk** - lines with `+` (add) or `-` (remove), optionally context lines (space-prefixed). The skill applies the hunk to the file.

Call **run_skill** with **skill: "apply-patch"**. Set **command** or **arguments.action** to **apply** (or **apply-patch**).

## Arguments

- **arguments.path** (required) - File to patch. Relative to workspace or absolute.
- **arguments.hunk** (required) - The diff hunk text. Unified-style lines:
  - **Space** - context line (must match file)
  - **-** - line to remove
  - **+** - line to add

Prefer a full absolute path from the system root for `arguments.path`. If the user gives a relative path, resolve it from the known workspace, state dir, current directory, or discovered project path before calling the tool.

Example hunk:
```
  const x = 1;
- const old = true;
+ const updated = false;
```

## When to use

Use when the user says things like:
- "Apply this patch to main.js"
- "Add this line after line 10"
- "Remove the debug log and add the new check"
- "Apply the diff I'm pasting"

The skill finds where the hunk applies (by matching context), then applies add/remove. Fails if the context does not match the file.

## Tool schema

```tool-schema
apply_patch_apply
  description: Apply a Git-style diff hunk to a file. path and hunk required.
  parameters:
    path: string
    hunk: string
```
