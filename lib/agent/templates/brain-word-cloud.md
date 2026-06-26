# Brain Word Cloud

You create a word cloud for Pasture Protocol's Brain dashboard.

The input is a JSON payload containing text excerpts gathered mechanically from:

- long-term memory files such as `MEMORY.md`
- custom memory notes under `memory/*.md`
- private chat history grouped by day

Your job is to identify the most salient words and short concepts that represent the recurring shape of the corpus, plus the strongest associations between those concepts.

## Selection rules

- Prefer concrete nouns, named entities, projects, tools, people, places, recurring goals, recurring concerns, and durable topics.
- Prefer terms that would help the user visually understand what the agent's memory/history has been centered on.
- Include short phrases when a phrase is more meaningful than one isolated word.
- Do not include generic conversational filler, function words, timestamps, JSON field names, markdown syntax, or transport/channel noise.
- Do not include log artifacts, command output, process output, stack traces, local development URLs, localhost ports, API port notes, file paths, or system-generated status lines unless the memory explicitly says the user cares about that as a durable topic.
- Do not treat one-off implementation details as brain topics. For example, a temporary localhost API, a printed server URL, or a command result is not a Brain term.
- Do not include secrets, tokens, credentials, phone numbers, email addresses, or exact private identifiers.
- If a term appears in multiple source types, reflect that with `sources`.
- Weight terms by salience, not just frequency. Use numbers from 1 to 100.
- Return between 14 and 24 terms when enough material exists. Return fewer if the corpus is sparse.
- Return associations only between terms you included in `terms`.
- Association strength means conceptual closeness in the corpus, not just visual similarity. Use numbers from 1 to 100.
- Prefer a sparse graph: 1-2 strong connections per important term, not every possible pair.
- Return at most 32 connections.
- Keep `reason` empty unless it is essential.

## Input shape

```json
{
  "range": "all | 30d | 7d",
  "source": "all | memory | notes | history",
  "corpus": [
    {
      "source": "memory | notes | history",
      "label": "MEMORY.md or date",
      "text": "excerpt"
    }
  ]
}
```

## Output shape

Return ONLY valid JSON. No prose. No markdown fences. No extra keys.

```json
{
  "terms": [
    {
      "text": "project planning",
      "weight": 92,
      "sources": ["memory", "history"]
    }
  ],
  "connections": [
    {
      "from": "project planning",
      "to": "Timeline project",
      "strength": 88,
      "reason": ""
    }
  ]
}
```

`text` must be a display-ready word or short phrase.
`weight` must be an integer from 1 to 100.
`sources` must contain one or more of: `memory`, `notes`, `history`.
`from` and `to` must exactly match term `text` values.
`strength` must be an integer from 1 to 100.
`reason` should be short and can be empty if there is no useful concise reason.
