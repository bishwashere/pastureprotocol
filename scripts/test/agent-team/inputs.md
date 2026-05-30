# Agent team E2E (`test-agent-team-e2e.js`)

Natural user messages only — no tool names, no "reply with exact answer".

## Why `test-agent-team-flow.js` was removed

That file was deleted in favor of **real user-path E2E** (`index.js --test` / dashboard). It called `executeAgentSend` and a **mock** sub-agent runner directly, which violated [E2E.md](../E2E.md) (no inner mocking).

| Old flow scenario | Where it lives now |
| --- | --- |
| Create team + links | Fixture setup in `agent-team-fixture.js` (not a separate test row) |
| Rename → Chloe, resolve aliases | `test-agent-config.js` (config contract, no LLM) |
| Delegate by alias / canonical id | `test-agent-team-e2e.js` (natural chat + real `agent-send`) |
| Remove / re-add alex link | `test-agent-team-e2e.js` |
| Stale allow `[chloe, ghost]` → repair | `test-agent-config.js` |
| Short reply "Chloe" after rename offer | Partially similar to two-turn nickname test; full history probe not duplicated in E2E |
| New session ack | `test-agent-team-e2e.js` + `test-chat-session.js` |

Run config contracts: `node scripts/test/test-agent-config.js`

## E2E scenarios

| Scenario | User says |
|----------|-----------|
| New session | new session |
| Delegate to marketer | Hey, ask the marketer — what's our company tagline? |
| Dashboard same | Hey, ask the marketer — what's our company tagline? |
| After rename to Chloe | Could you ask Chloe what our company tagline is? |
| Two-turn | Turn1: Let's call the marketer agent Chloe. Turn2: Could you ask Chloe what our company tagline is? |
| Alex not linked | Can you check with Alex if he's around? |
| Alex linked again | Can you check with Alex if he's around? |
