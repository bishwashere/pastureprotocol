---
id: cron
name: Cron
description: Manage reminders and scheduled messages. Actions: list, add, remove. See skill.md for arguments.
---

# Cron

Manage reminders and scheduled messages: **one-shot** (at a specific time) or **recurring** (every morning, every 5 minutes, etc.). Call **run_skill** with **skill: "cron"**. The **command name** is the operation: use **command** or **arguments.action** set to exactly one of: **list**, **add**, **remove**.

**Reply channel:** By default the reminder reply is sent to the **same channel** (WhatsApp chat or Telegram chat) where the user set it up. This is stored with the job and used even when a separate cron process runs the task-no need to specify a channel; it stays attached to where it was created.

## Commands (name is command)

- **list** - Use when the user asks to list, see, count, or check for reminders ("how many crons?", "list my reminders", "what's scheduled?", "do I have any reminders?"). Call once only. Do not also call add. No other fields needed. **Always reply with the full list of reminders** (one-time and recurring), even if the user only asked "do I have any?" or "are there any?" - never reply with only a count like "you have 7 reminders". If there are none, say so explicitly. **Never include raw cron expressions** (e.g. `0 8 * * 1`) in the reply - always convert to human-readable form (e.g. "Every Monday at 8:00 AM"). Use the stored human-readable message and the schedule kind (at/cron) to produce a natural description.
- **add** - When the user's **intent** is to CREATE or SET a reminder, or to have something **checked repeatedly** or **get notified when something happens** (e.g. status change, arrival, result). Treat that intent as a request to create a job; do not ask for confirmation before adding. Set **arguments.job** with **message** (what to check or remind) and **schedule**:
  - **One-shot:** `{ "kind": "at", "at": "<future ISO 8601>" }`. Always use an exact full ISO 8601 timestamp (e.g. 2026-02-19T08:00:00.000Z). Schedules are saved and run at that exact time. For "in 1 hour" or "tomorrow 8am" compute the exact datetime and pass it as ISO 8601.
  - **Recurring (cron):** `{ "kind": "cron", "expr": "<cron expression>", "tz": "optional IANA timezone" }`. Use the **expr** values below for common setups. Never invent message text. **If the user does not specify how often to check,** use a sensible default (e.g. every 10 minutes: `*/10 * * * *`), create the job, then say they can change the interval or remove it later.
  - **Direct conditional HTTP poll:** When the user gives a plain HTTP/JSON URL and asks to notify only if the response is non-empty, create a direct poll job, not a generic LLM reminder. Include either top-level `job.url` + `job.notifyWhen`, or `job.conditional`: `{ "notifyWhen": "non_empty_response", "url": "<url>", "label": "<short label>" }`. Keep `job.message` human-readable, but the structured condition is what suppresses empty responses. Empty means empty body, `[]`, `{}`, or `null`.
- **remove** - When the user asks to cancel a reminder. Set **arguments.jobId** (from a previous list result). **When the user refers to a reminder by position** (e.g. "remove reminder number 3", "delete the third one"): call `list` first to get the numbered list (1-indexed from top), find the job at that exact position across the full combined list (one-time + recurring in the order shown), then call `remove` with that job's id. Confirm what was removed by name and position.

You can pass the command at the top level (`command: "list"`) or inside arguments (`arguments.action: "list"`). Never omit the command/action.

## Recurring (cron) - every morning, every 5 minutes, etc.

Cron **expr** is usually 5 fields: **minute hour day-of-month month day-of-week**. For second-level direct polling only, Croner also accepts 6 fields: **second minute hour day-of-month month day-of-week**. Use these for natural-language requests:

| User says | **expr** | Meaning |
|-----------|----------|---------|
| every 20 seconds | `*/20 * * * * *` | Every 20 seconds |
| every 5 minutes | `*/5 * * * *` | Every 5 minutes |
| every minute | `* * * * *` | Every minute |
| every hour | `0 * * * *` | At minute 0 of every hour |
| every morning / every day at 8am | `0 8 * * *` | 8:00 daily |
| every day at 9am | `0 9 * * *` | 9:00 daily |
| every Monday at 8am | `0 8 * * 1` | 8:00 on Mondays (1 = Monday, 0 = Sunday) |
| every weekday at 8am | `0 8 * * 1-5` | 8:00 Mon–Fri |

Optional **tz** for timezone (e.g. `"America/New_York"`). Example job for "every morning at 8": `{ "message": "Good morning reminder", "schedule": { "kind": "cron", "expr": "0 8 * * *", "tz": "America/New_York" } }`.

## Notes

- **Intent over wording:** Recognize the intent to have something checked repeatedly or to be notified when something happens; create the recurring job with a default interval if the user did not specify one. Prefer acting (add with sensible defaults) over asking for interval or cutoff first.
- **Confirmation reply for recurring jobs:** When confirming a recurring reminder was added, write a natural confirmation in plain English (e.g. "I'll remind you every 5 minutes", "Daily reminder set for 9 AM", "Every Monday at 8 AM reminder created"). Do **not** expose raw cron expressions, tool-call JSON, or internal arguments in the user-facing reply.
- For multiple new reminders in one message, call run_skill(cron, add) once per reminder with different job.message and job.schedule.
- For "every one minute for the next three minutes" use three one-shot **at** times. For "every 5 minutes" or "every morning" use **cron** with the **expr** above.

## Tool schema

```tool-schema
cron_list
  description: List all scheduled jobs/reminders. No parameters.

cron_add
  description: Create a reminder or direct conditional HTTP poll. Set job with message and schedule (kind at|cron, at or expr, tz). For direct HTTP polls, set job.notifyWhen="non_empty_response" and job.url, or job.conditional.
  parameters:
    job: object

cron_remove
  description: Remove a scheduled job by id (from list result).
  parameters:
    jobId: string
```
