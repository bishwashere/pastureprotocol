# Agent config (unit — no LLM)

**This suite does not run the chat agent or LLM.** It only checks config on disk (team links, rename aliases, allow-list repair).

For **real user messages → LLM → bot reply → agent-send**, use **[Agent Team E2E](../agent-team/inputs.md)** in the Tests panel (`pnpm run test:agent-team-e2e`).

| | |
|--|--|
| **Test file** | `scripts/test/unit/agent/test-agent-config.js` |

## Inputs

| Scenario | Message |
|----------|---------|
| Team links | Setup: main.agentMessaging.allow = [marketer, alex] |
| Rename Chloe | Setup: PATCH marketer title to Chloe, then resolve Marketer / chloe / Chloe |
| Stale allow list | Setup: save allow [chloe, ghost, alex] — expect marketer (not chloe), no ghost |

Expected **Output** in the UI: JSON-style facts (`allow=[...]`, `resolveAgentReference` results) — not a chat reply.
