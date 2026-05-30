# E2E Tests: What We Test

E2E tests validate **user-visible behavior** through the real app entry point — not by calling inner functions directly.

## Entry points (no Telegram required)

| Entry | Same as |
|---|---|
| `node index.js --test "message"` | Telegram / WhatsApp private chat (`runAgentWithSkills`) |
| `node scripts/chat-dashboard.js` (stdin JSON) | Web dashboard chat |

Only **transport** is skipped (mock socket instead of Telegram send). Routing, planner, LLM, tools, delegation, and sub-agent turns are **not mocked**.

## What we are testing

1. **User message in** → main app handles the turn end-to-end.
2. **Skill / delegation behavior** — real tool calls when the model chooses them (not because the test text names a skill).
3. **Whether the user got what they wanted** — a separate LLM **judge** reads the user message and bot reply (YES/NO).

**Test prompts must sound like real users.** Do not put tool names (`agent-send`, `search`, etc.) or meta-instructions (`Reply with their exact answer`) in user messages unless the scenario is explicitly about testing a command (e.g. `/browse-reset`).

## What we are NOT doing in E2E tests

- Calling `executeAgentSend`, `executeSkill`, or config helpers **as the test body** (setup on disk before the first message is OK).
- Mocking sub-agents, internal runners, or tool results after the message is sent.
- Live Telegram / WhatsApp network (use `--test` or `chat-dashboard.js` instead).

## Flow

```
User message  →  index.js --test  OR  chat-dashboard.js  →  Reply
                     ↓
              LLM judge: “Did the user get what they wanted?”
                     ↓
              Pass / Fail
```

Shared runner: `skill-test-runner.js` (`runSkillTests`). Report table: `e2e-report.js` (`recordCase`, `startReport` / `endReport` — prints **Input | Output | Status** per case). Helpers: `e2e-run.js` (`runE2E`, `runDashboardE2E`).

## Internal contract tests

Tests that verify **pure logic** (session day keys, config normalization, HTML layout, executor guards in isolation) may call functions directly. They are **not** user E2E. User-facing behavior must go through an entry point above.

## Expect modes (`behavior` vs `actual`)

See **[E2E_EXPECT.md](E2E_EXPECT.md)** and `e2e-expect.js`.

## Skill test inputs

Each skill folder has an `inputs.md` listing **user messages** the E2E uses. Those strings must match the test file and must read like real chat (no skill/tool names unless testing a slash command). Sub-agent `SOUL.md` / fixture text may pin expected answers for stability; that is not a user message.

| Folder | Test file | Entry |
|--------|-----------|--------|
| [cron/](cron/inputs.md) | `test-cron-e2e.js` | `--test` |
| [agent/](agent/inputs.md) | `test-agent.js` | `--test` |
| [agent-team/](agent-team/inputs.md) | `test-agent-team-e2e.js` | `--test` + dashboard |
| [agent-team/](agent-team/inputs.md) | `test-agent-config.js` | direct (config only; replaces deleted `test-agent-team-flow.js`) |
| [basic/](basic/inputs.md) | `test-basic-e2e.js` | `--test` |
| - | `test-chat-session.js` | direct (session logic only) |
| [edit/](edit/inputs.md) | `test-edit-e2e.js` | `--test` |
| [write/](write/inputs.md) | `test-write-e2e.js` | `--test` |
| [browser/](browser/inputs.md) | `test-browser-e2e.js` | `--test` |
| [memory/](memory/inputs.md) | `test-memory-e2e.js` | `--test` |
| [me/](me/inputs.md) | `test-me-e2e.js` | `--test` |
| [home-assistant/](home-assistant/inputs.md) | `test-home-assistant-e2e.js` | `--test` |
| [vision/](vision/inputs.md) | `test-vision-e2e.js` | `--test` |
| [apply-patch/](apply-patch/inputs.md) | `test-apply-patch-e2e.js` | `--test` |
| [read/](read/inputs.md) | `test-read-e2e.js` | `--test` |
| [go-read/](go-read/inputs.md) | `test-go-read-e2e.js` | `--test` |
| [core/](core/inputs.md) | `test-core-e2e.js` | `--test` |
| [go-write/](go-write/inputs.md) | `test-go-write-e2e.js` | `--test` |
| [search/](search/inputs.md) | `test-search-e2e.js` | `--test` |
| [server-inspect/](server-inspect/inputs.md) | `test-server-inspect-e2e.js` | `--test` |
| [speech/](speech/inputs.md) | `test-speech-e2e.js` | `--test` |
| [gog/](gog/inputs.md) | `test-gog-e2e.js` | `--test` |
| [tide/](tide/inputs.md) | `test-tide.js` | direct (payload) |
