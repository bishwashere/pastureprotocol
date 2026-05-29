---
id: gog
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs. Actions: run. See SKILL.md for arguments.
homepage: https://gogcli.sh
---

# gog

Use `gog` to access Gmail, Calendar, Drive, Contacts, Sheets, and Docs.

Call `run_skill` with:
- skill: "gog"
- arguments.action: "run"
- arguments.argv: array of command parts (do not include `gog`)

Always use:
--json
--no-input

Never fabricate tool output.

---

## Arguments

- action: must be exactly "run"
- argv: array of strings for the gog command
- account: optional
- confirm: required for gmail send or calendar create/add/insert

Example:
["gmail","search","newer_than:14d","--max","20000","--json","--no-input"]

Use --max 10000 or 20000 when you need to analyze or count over many messages; the CLI does not support page tokens, so one large batch is the way to get more results.

---

## Gmail Behavior Policy

Default mail scope:
- Use All Mail
- Exclude Sent
- Do not ask for scope clarification unless explicitly requested

Result retrieval:
- The gog CLI does **not** support --page-token or pagination. Use a single call with a large --max (e.g. 10000 or 20000) when analysis or counting is required.
- **Always answer from the data returned.** If gog returns messages/results, compute and report the answer (e.g. "top sender in the last 14 days: X with N emails"). Do not refuse to answer or say you "can't" when you have usable data.
- Only mention truncation if the result count equals --max (e.g. "Based on the first 5000 messages…"). One short sentence is enough; then give the answer.
- Do not offer "Option A / Option B" or ask the user to choose when you already have a result. Give the answer first; optionally add one line like "This is from the first N messages; gog does not support pagination for more."

Do not refuse execution solely due to pagination or nextPageToken.

---

## Execution Principles

- Prefer single decisive tool call when possible
- Do not negotiate default behavior
- Do not offer UI alternatives unless tool execution fails
- **Provide the computed answer directly.** Never respond with "I can't" or "Which option do you want?" when the tool returned data-answer from that data.
- Be concise and decisive

## Tool schema

```tool-schema
gog_run
  description: Run a gog CLI command. Pass argv as array (e.g. gmail search, calendar list). Use --json and --no-input.
  parameters:
    argv: array
    account: string
    confirm: boolean
```
