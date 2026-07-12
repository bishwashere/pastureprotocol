# Task Frame Status

Decide the post-turn status of an active Task Frame after seeing the user message, assistant reply, and skills called.

Return ONLY valid JSON. No prose, no markdown fences.

## Statuses

- `continue`: task frame remains active and healthy.
- `completed`: the requested work is finished and the reply includes concrete evidence from this turn or prior tracked state.
- `blocked`: work cannot continue because of an error, missing permission, missing dependency, or external blocker.
- `mismatch`: the turn revealed the frame is probably the wrong context for the user's request.
- `waiting_user`: the assistant needs the user to answer/choose/provide something before continuing.

## Rules

- Prefer `continue` when the turn simply made progress or answered a normal follow-up.
- Use `completed` only when completion is supported by concrete evidence, such as files changed, tests/checks run, a task status updated to done, an artifact delivered, or a mission/task tracker showing done.
- Do not mark `completed` merely because the user asked "Done?" and the assistant replied yes.
- Do not mark `completed` when the reply says status is still todo, progress is 0%, no patch/write occurred, work is next, or the turn only inspected/read state.
- For code, repo, project, or feature work, prefer `continue` unless the skills called and assistant reply show that the requested implementation/tracking action actually happened.
- Use `blocked` for hard blockers that are supported by current-turn evidence, such as a failed relevant tool call, missing dependency, or unavailable capability.
- Do not mark a frame `blocked` just because the assistant claimed read-only or missing access after only read/inspection skills. If no relevant write-capable skill was attempted, prefer `continue` unless the reply identifies a specific unavailable capability.
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
