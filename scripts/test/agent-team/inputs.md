# Agent team E2E (`test-agent-team-e2e.js`)

Natural user messages only — no tool names, no agent names, no "ask the marketer/Chloe/Alex". Delegation must come from specialization matching.

## Why `test-agent-team-flow.js` was removed

That file was deleted in favor of **real user-path E2E** (`index.js --test` / dashboard). It called `executeAgentSend` and a **mock** sub-agent runner directly, which violated [E2E.md](../E2E.md) (no inner mocking).

| Old flow scenario | Where it lives now |
| --- | --- |
| Create team + links | Fixture setup in `agent-team-fixture.js` (not a separate test row) |
| Rename → Chloe, resolve aliases | `test-agent-config.js` (config contract, no LLM) |
| Delegate by specialization (not agent name) | `test-agent-team-e2e.js` (natural chat + real `agent-send`) |
| Remove / re-add alex link | `test-agent-team-e2e.js` |
| Stale allow `[chloe, ghost]` → repair | `test-agent-config.js` |
| Short reply "Chloe" after rename offer | Partially similar to two-turn nickname test; full history probe not duplicated in E2E |
| New session ack | `test-agent-team-e2e.js` + `test-chat-session.js` |

Run config contracts: `pnpm run test:agent-config` (see **agent-config** in Tests panel).

## Inputs

### E2E scenarios

| Scenario | User says |
|----------|-----------|
| New session | new session |
| Marketing ask (Telegram path) | What's our company tagline for marketing materials? |
| Marketing ask (dashboard path) | What's our company tagline for marketing materials? |
| After rename to Chloe | What's our company tagline for marketing materials? |
| Two-turn marketing lane + ask | Turn1: Taglines, campaigns, and brand stuff should go through whoever owns marketing on the team. Turn2: What's our company tagline for marketing materials? |
| Backend not linked | Can you investigate why our GitHub CI check is failing and propose a fix? |
| Backend linked again | Can you investigate why our GitHub CI check is failing and propose a fix? |
| SuggestedTask-style risk + experiment prompt | Users drop off right after signup. What risk should we prioritize first, and what small experiment should we run this week? |
| Proactive feasibility review | We have an onboarding improvement idea. Can you review technical feasibility and rollout risks before we proceed? |
| Team count + recent movements | How many agents are there, and what are the recent movements? |
| Named agent last five tasks | What did Alex do in his last five tasks? |
| Attention + completed work | What is in need of attention, and what work has been completed? |
