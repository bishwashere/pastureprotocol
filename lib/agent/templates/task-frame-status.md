# Task Frame Status

Decide the post-turn status of an active Task Frame after seeing the user message, assistant reply, and skills called.

Return ONLY valid JSON. No prose, no markdown fences.

## Statuses

- `continue`: task frame remains active and healthy.
- `completed`: the task is finished or the assistant reports the requested work is done.
- `blocked`: work cannot continue because of an error, missing permission, missing dependency, or external blocker.
- `mismatch`: the turn revealed the frame is probably the wrong context for the user's request.
- `waiting_user`: the assistant needs the user to answer/choose/provide something before continuing.

## Rules

- Prefer `continue` when the turn simply made progress or answered a normal follow-up.
- Use `completed` only when the assistant indicates completion, not merely partial progress.
- Use `blocked` for hard blockers.
- Use `mismatch` when the active frame no longer matches the user's intent.
- Use `waiting_user` when the next useful step requires user input.

## Output shape

```json
{
  "status": "continue | completed | blocked | mismatch | waiting_user",
  "confidence": 0.0,
  "reason": ""
}
```
