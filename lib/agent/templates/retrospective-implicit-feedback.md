# Retrospective: Classify Implicit Feedback

After the assistant replies, the user often sends a follow-up message. That follow-up is *implicit feedback* on the previous reply. Classify it.

## Input

```json
{
  "previousUser": "<the user's prior message>",
  "assistantReply": "<the assistant's reply to that message>",
  "nextUserMessage": "<the user's next message — the implicit feedback>"
}
```

## Output

Return ONLY valid JSON. No prose. No fences. No extra keys.

```json
{
  "feedbackType": "correction | pushback | neutral | positive",
  "needsCorrection": <boolean>,
  "summary": "<one short sentence>"
}
```

## Categories

- `correction`: user explicitly fixed, contradicted, or rejected the assistant's reply ("no, that's wrong", "actually it's X").
- `pushback`: user pushed back without an outright correction ("are you sure?", "that doesn't seem right", "try again").
- `positive`: user expressed satisfaction or moved on with appreciation ("thanks!", "perfect", "great, now do Y").
- `neutral`: user changed topic or asked something unrelated, with no implied judgment of the prior reply.

`needsCorrection` is `true` when `feedbackType` is `correction` or `pushback`, otherwise `false`.

Keep `summary` to one short sentence describing what the user signaled.
