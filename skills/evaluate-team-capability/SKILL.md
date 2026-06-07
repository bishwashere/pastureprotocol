---
id: evaluate-team-capability
name: Evaluate team capability
description: Scan linked teammates and score who best fits a user request. Returns ranked agents with relevance scores, reasoning, and a recommendation (delegate, handle-in-main, adapt, or create-new). Call when the topic does not clearly match your active skills or before deciding whether to delegate.
---

# Evaluate team capability

Use this when you are the **coordinator** (main/CEO) and need to decide whether to handle a request yourself, delegate to a linked specialist, adapt an existing teammate, or offer to create a dedicated agent/mission.

**Automatic routing:** Before each turn, keyword scoring runs first. If no strong match, an **LLM semantic router** reads agent titles, aliases, SOUL excerpts, and skills to pick a specialist (when confidence ≥ 0.7). You usually do not need to call this skill manually — it is reflected in inbox routing logs.

## When to use

- The user asks for something outside your obvious skill set (e.g. fitness, legal, design) and no teammate is an obvious fit.
- You want structured relevance scores before calling `agent-send`.
- You need to offer an upgrade path: handle now vs create a specialist agent vs turn it into an autonomous Mission.

Do **not** use for simple greetings or when you already delegated this turn.

## Output shape

The tool returns JSON with:

- **agents** — ranked list (includes you as coordinator) with `confidencePct`, `matchedSkills`, `reasoning`
- **recommendation.action** — one of:
  - `delegate` — strong specialist match; use `agent-send` next
  - `handle-in-main` — you answer now; offer upgrade if `offerUpgrade` is true
  - `adapt` — partial match on an existing teammate; consider extending their skills or delegating with caveats
  - `create-new` — no good fit; offer a dedicated agent and/or autonomous Mission

## How to respond after evaluation

| action | What to do |
|--------|------------|
| `delegate` | Call `agent-send` to the recommended agent (or `auto`) with the full user message. |
| `handle-in-main` | Answer the user directly. If `offerUpgrade`, briefly offer: handle yourself, or create a dedicated specialist / Mission. |
| `adapt` | Explain the partial fit, delegate with caveats if useful, or offer to broaden a teammate's skills. |
| `create-new` | Help now if you can, then offer creating a dedicated agent persona + optional Mission for long-term tracking. |

## Tool schema

```tool-schema
evaluate_team_capability
  description: Score all linked teammates (and yourself as coordinator) for a user request. Returns ranked relevance, reasoning, and recommendation (delegate / handle-in-main / adapt / create-new).
  parameters:
    request: string
```
