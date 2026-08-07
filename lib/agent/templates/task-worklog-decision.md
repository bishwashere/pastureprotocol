# Task Worklog Decision

Decide whether this agent run needs a durable per-run worklog so important early tool results remain available after many later steps or context truncation.

Set `needsWorklog` to `true` when the request is likely to require several meaningful tool rounds, a broad inventory of independent projects/repos/services/accounts, multi-step research/debugging/implementation/verification, background-style work, or a final answer combining many separately gathered facts.

Set it to `false` for chat, one quick lookup/count, one simple tool call, or an answer already available from conversation context. Judge the likely execution shape, not particular keywords.

Return JSON only:

```json
{"needsWorklog":false,"reason":"short reason"}
```
