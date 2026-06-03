---
id: agent-send
name: Agent send
description: Delegate a question or task to another configured agent and get its reply back. Use when the user wants you to coordinate a team of agents (e.g. a PM asking a specialist), or when another agent owns the knowledge/tools needed. Only works for agents in this agent's allow list.
---

# Agent send

Send a message to **another agent** running in this same cowCode and get its reply, so you can act as a coordinator over a team of specialist agents (the "PM to PM" pattern). The target agent runs a full turn with its own persona, skills, and memory, then returns text to you. Nothing is sent to WhatsApp/Telegram - the exchange is internal.

When a related **Goal** is active, delegations create a **persistent assigned subgoal** on that mission (assignee, due date, expected output, status tracking). The target agent sees the assignment in their mission context; you can follow progress on the goal's subgoal tree.

Conversation history with each target agent is remembered across calls, so follow-up delegations build on the earlier ones.

## When to use

- The user asks you to coordinate or ask a specific agent (e.g. "ask the backend agent", "check with the reviewer").
- A task is clearly owned by another agent's persona or skills.
- You are a coordinator/PM agent delegating subtasks and synthesizing the answers.
- A goal tick or mission plan needs a structured hand-off with ownership and a deadline.

Do **not** use it to talk to yourself, and do not use it in group chats (it is disabled there).

## How to call

Use the **agent_send_send** tool with:

- **agent** (required) - the target agent **id** (e.g. `"backend"`) or display **title** (e.g. `"Marketer"`). Must be in your allow list. Prefer the canonical id from the Agent team block in your system prompt. You can also pass `"auto"` to let cowCode pick the best linked teammate by skill match.
- **message** (required) - the full question/task. Include everything the target needs; it does not see your conversation with the user.

Optional **persistent task assignment** fields (recommended when working on a Goal):

- **taskTitle** - short title for the assigned subgoal (defaults to first line of message).
- **expectedOutput** - what the assignee should deliver (e.g. "3 blog headlines with rationale").
- **dueInHours** - deadline in hours from now (default 48 when a goal is linked).
- **goalId** - explicit goal id when multiple missions are active (otherwise inferred from context).
- **persistTask** - set `false` to skip creating a tracked subgoal (message-only delegation).

After you get the reply, synthesize a single answer for the user. You may message multiple agents (subject to the per-turn limit) and combine their replies.

## Limits and safety

- **Allow list** - you can only message agents linked on the team map (`agentMessaging.allow`).
- **No self / no loops** - you cannot message yourself or any agent already in the current delegation chain.
- **Depth** - delegations can nest only up to `agentMessaging.maxDepth` (default 2).
- **Per-turn cap** - at most `agentMessaging.maxCallsPerTurn` delegations per turn (default 5).

If a call is rejected, the tool result explains why. Do not retry the same blocked call; tell the user instead.

## Configuration

Team links on the **agent map** (or `agentMessaging.allow` in the agent config) define who this agent can delegate to. When links exist, `agent-send` is enabled automatically — no separate skill toggle.

Optional limits in the agent config (defaults shown):

```jsonc
{
  "agentMessaging": {
    "allow": ["backend", "reviewer"],
    "maxDepth": 2,
    "maxCallsPerTurn": 5
  }
}
```

## Examples

Ask the backend agent a question:

`agent_send_send` with `{ "agent": "backend", "message": "Propose JWT vs session auth for a REST API and justify briefly." }`

Structured mission hand-off with tracking:

`agent_send_send` with `{ "agent": "marketer", "message": "Research competitor signup flows and summarize friction points.", "taskTitle": "Competitor signup research", "expectedOutput": "3 competitor examples with 2 friction points each", "dueInHours": 24 }`

Auto-route to the best linked specialist:

`agent_send_send` with `{ "agent": "auto", "message": "Please investigate why GitHub CI is failing and suggest a fix." }`

Coordinate two specialists, then summarize:

`agent_send_send` with `{ "agent": "backend", "message": "Draft the auth approach." }`
then `agent_send_send` with `{ "agent": "reviewer", "message": "Review this auth approach: <paste backend reply>" }`

## Tool schema

```tool-schema
agent_send_send
  description: Delegate a message to another configured agent and return its reply. Creates a persistent assigned subgoal on the active Goal when one is linked (assignee, due date, expected output). agent is the target agent id or display title (must be in your allow list); message is the full task/question (the target does not see your conversation with the user). Internal only - nothing is sent to any chat channel.
  parameters:
    agent: string
    message: string
    taskTitle: string
    expectedOutput: string
    dueInHours: number
    goalId: string
    persistTask: boolean
```
