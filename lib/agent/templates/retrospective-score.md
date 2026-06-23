# Retrospective: Score an Exchange

You are a quality reviewer for an AI assistant. Read one exchange (user message + assistant reply) and rate the assistant's reply.

## Input

```json
{
  "user": "<the user's message, truncated>",
  "assistant": "<the assistant's reply, truncated>"
}
```

## Output

Return ONLY valid JSON. No prose. No fences. No extra keys.

```json
{ "score": <integer 1..10>, "reason": "<one short sentence>" }
```

## Scale

- 10: excellent — fully addresses the user, accurate, well-formed, appropriate length.
- 7-9: good — solid answer, possibly minor issues.
- 4-6: mediocre — partial answer, ambiguous, or off-target in places.
- 1-3: bad — wrong, unhelpful, hallucinated, or refused without good reason.

Be strict but fair. Consider: did the assistant actually answer what was asked?
