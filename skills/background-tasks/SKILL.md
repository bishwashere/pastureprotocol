---
id: background-tasks
name: Background tasks
description: Run long work in the background without blocking chat. Spawn returns a task id immediately; results are announced when done. Use /tasks to list jobs.
---

# Background tasks

Offload **long or heavy work** to a background agent turn. The user gets an immediate ack with a task id; you stay responsive in chat while the work runs. When the background turn finishes, cowCode **announces the result** in the same chat.

This is the cowCode equivalent of OpenClaw sub-agents (`sessions_spawn`).

## When to use

- Research, multi-step browsing, large file analysis, or anything that may take minutes.
- The user says "do this in the background", "run this async", or clearly won't want to wait inline.
- You would otherwise block chat for a long tool loop.

Do **not** spawn for quick one-liner answers. Do **not** nest background tasks (spawn from inside a background task is blocked).

## Commands

- **`/tasks`** — user can type this anytime to list background jobs for this chat (running, done, failed).
- **`background_tasks_list`** — same listing from a tool call.

## How to call

### Spawn

Use **`background_tasks_spawn`** with:

- **prompt** (required) — full task for the background agent. Include all context; the background turn does not see the live chat after spawn.
- **label** (optional) — short title shown in `/tasks` (defaults to prompt snippet).

Returns `{ taskId, shortId, status: "running" }`. Tell the user the short id and that you'll announce when done.

### List

**`background_tasks_list`** — no parameters.

### Cancel

**`background_tasks_cancel`** with **taskId** (full id or short prefix from `/tasks`).

Cancellation is best-effort: a task already mid-LLM may still finish internally but won't announce if cancelled before completion.

## Limits

- At most **3 running** background tasks per chat.
- Cannot spawn from inside a background task.

## Examples

User: "Research our top 5 competitors in the background"

→ `background_tasks_spawn` with `{ "prompt": "Research our top 5 competitors...", "label": "Competitor research" }`

→ Reply: "Started background task a1b2c3d4 — I'll post the results here when it's done. `/tasks` to check status."

## Tool schema

```tool-schema
background_tasks_spawn
  description: Start a long-running task in the background. Returns a task id immediately; result is announced in chat when done. prompt is the full task (required); label is a short title for /tasks (optional).
  parameters:
    prompt: string
    label: string

background_tasks_list
  description: List background tasks for this chat (running, done, failed).
  parameters:

background_tasks_cancel
  description: Cancel a running background task by taskId (from spawn or /tasks).
  parameters:
    taskId: string
```
