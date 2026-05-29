# Skill format (compact-compatible)

One central agent handles everything: it picks the right skill from the list, runs it in the shared executor, and keeps things smooth. Skills add smarts like shortcuts or recipes; the heavy lifting stays shared. No babysitters, no extras.

Every skill is **one file**: `SKILL.md`. There is no `skill.json` - all metadata lives in the markdown frontmatter and body. No separate JS or config file for actions; everything is defined in the same SKILL.md.

Every skill must be **compact-compatible** so the loader can inject a short list (id + description) on each run and full doc when the skill is called.

## Required frontmatter (in SKILL.md only)

In each skill's `SKILL.md`, use YAML frontmatter between the first `---` and second `---`. No separate structure file; id and description are enough for discovery:

- **`id`** (optional) - Skill id used in `run_skill` (defaults to folder name). Must match the skill folder name (e.g. `cron`, `search`, `memory`).
- **`description`** (required) - One-line summary for the compact list. Keep it under ~280 characters. Used when the loader builds the compact list; the model sees this before choosing a skill.
- **`name`** (optional) - Human-readable label (e.g. "Cron", "Apply patch"). Used for display; the compact list still shows `id` so the model passes the correct value to `run_skill`.

## Optional: tool schema (actions in the same SKILL.md)

To give the LLM **explicit tools per action** (one tool per variation, with clear parameters), add a **tool schema** block in the **same** SKILL.md body. The loader parses it and builds one tool per action with structured parameters; no separate JS or JSON file.

Use a fenced code block with the info string `tool-schema` in the body of SKILL.md. Example section:

    ## Tool schema

    ```tool-schema
    list
      description: List all scheduled jobs/reminders.

    add
      description: Create a reminder. Use job with message and schedule (kind at|cron, at or expr, tz).
      parameters:
        job: object

    remove
      description: Remove a scheduled job by id (from list result).
      parameters:
        jobId: string
    ```

**Format rules:**

- First line inside the block is an **action name** (no spaces). Use **prefixed** form (e.g. `cron_list`, `cron_add`, `search_search`) so the tool name is explicit; the loader also accepts unprefixed (e.g. `list`, `add`) and will prefix it.
- Indented lines under it (two spaces):
  - `description: ...` - Short description for this action (used as the tool description).
  - `parameters:` - Optional. Next lines at same indent list `paramName: type`. Types: `string`, `object`, `array`, `number`, `boolean`. Add `(optional)` after the type for optional params.
- Blank line or a new non-indented action name starts the next action.
- If a skill has **no** `tool-schema` block, the loader falls back to the single `run_skill` tool (model chooses skill + arguments as before).

**Example (cron, prefixed actions):**

```tool-schema
cron_list
  description: List all scheduled jobs/reminders.

cron_add
  description: Create a reminder. Set job.message and job.schedule (kind at|cron, at or expr, tz).
  parameters:
    job: object

cron_remove
  description: Remove a job by id from list result.
  parameters:
    jobId: string
```

The loader builds tools named `cron_list`, `cron_add`, `cron_remove` with the given parameters. The model calls the right tool with the right arguments; the executor receives the same `skillId` and `runArgs` (with the executor action derived by stripping the skill prefix when present).

## Example (minimal, no tool schema)

```markdown
---
id: cron
name: Cron
description: Manage reminders and scheduled messages. Actions: list, add, remove. See skill.md for arguments.
---

# Cron
...
```

## Parser behavior

- **Compact list:** The loader extracts `description` (and optionally `name`) and builds one line per skill: `- **id**: description`.
- **Tool schema:** If the body contains a ` ```tool-schema` block, the loader parses it and builds one OpenAI-format tool per action (name: `{id}_{action}`, parameters from the block). Otherwise it emits the single `run_skill` tool.
- **Fallback:** If `description` is missing, the first line of the body (after frontmatter) or the skill id is used.
- **Full doc:** When the model calls a skill (by tool name or run_skill), the full `SKILL.md` content can be injected into the tool result for that turn.

Ensure every skill has at least `description:` in frontmatter so the compact request works consistently.
