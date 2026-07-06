# E2E Tests: What We Test

E2E tests validate **user-visible behavior** through the real app entry point — not by calling inner functions directly.

## Entry points (no Telegram required)

| Entry | Same as |
|---|---|
| `node index.js --test "message"` | Telegram / WhatsApp private chat (`runAgentWithSkills`) |
| `node scripts/chat-dashboard.js` (stdin JSON) | Web dashboard chat |

Only **transport** is skipped (mock socket instead of Telegram send). In the **real** lane, routing, planner, LLM, tools, delegation, and sub-agent turns are not mocked. In the **fake** lane, any fake LLM/tool boundary must be explicit in the test file and the turn should still enter through `index.js --test`, `index.js --test-live`, or `chat-dashboard.js`.

## Suite lanes

The test suite is split first into **unit** and **E2E**. E2E is split again into two lanes:

| Lane | Command | Meaning |
|---|---|---|
| Real E2E | `pnpm run test:e2e:real` | Real app route, real configured LLMs/tools, sandboxed state where needed. |
| Fake E2E | `pnpm run test:e2e:fake` | Real app route with deterministic fake LLM/tool backends. No external provider dependency. |
| Both | `pnpm run test:e2e` | Runs real then fake lanes. |

All E2E lane runs stream to the terminal and are also appended live to the normal daemon log (`~/.pasture/daemon.log`, or `PASTURE_DAEMON_LOG_PATH` when set). This applies to both real and fake lanes, and to every test file run by `scripts/test/e2e/run-suite.js`.

The live log/weather conversation follows this same split:

| Lane | Command |
|---|---|
| Real | `pasture logs --test-live --real` or `pnpm run test:logs-real-e2e` |
| Fake | `pasture logs --test-live --fake` or `pnpm run test:logs-fake-e2e` |

`pasture logs --test-live` is the single CLI trigger for the live-log E2E cycle. It defaults to the fake/sandboxed lane unless `--real` is passed, and writes the run into the normal daemon log while streaming it in the terminal.

Every real E2E file must have a fake counterpart at the same relative path:

```text
scripts/test/e2e/real/<area>/test-name.js
scripts/test/e2e/fake/<area>/test-name.js
```

Fake counterparts must not silently use real providers and must not pass as placeholders. They must run a deterministic local fake backend. A missing fake backend is a failing E2E test.

## What we are testing

1. **User message in** → main app handles the turn end-to-end.
2. **Skill / delegation behavior** — real tool calls when the model chooses them (not because the test text names a skill).
3. **Whether the user got what they wanted** — a separate LLM **judge** reads the user message and bot reply (YES/NO).

**Test prompts must sound like real users.** Do not put tool names (`agent-send`, `search`, `browse`, `cron`, etc.), agent names (`ask Alex`, `ask the marketer`), or meta-instructions (`Reply with their exact answer`, `use the X skill`) in user messages unless the scenario is explicitly about testing a slash command (e.g. `/browse-reset`) or a **unit contract** that documents why the literal string is required.

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

Shared runner: `scripts/test/support/skill-test-runner.js` (`runSkillTests`). Report table: `scripts/test/support/e2e-report.js` (`recordCase`, `startReport` / `endReport` — prints **Input | Output | Status** per case). Helpers live in `scripts/test/support/`.

## Test layout

- `scripts/test/e2e/real/` — real app route, real configured LLMs/tools, sandboxed state where needed.
- `scripts/test/e2e/fake/` — matching fake-lane counterparts with deterministic local doubles or explicit fake-skip stubs.
- `scripts/test/e2e/real/skills/` and `scripts/test/e2e/fake/skills/` — skill/tool E2E pairs.
- `scripts/test/e2e/real/agent/` and `scripts/test/e2e/fake/agent/` — chat/delegation/team E2E pairs.
- `scripts/test/e2e/real/core/` and `scripts/test/e2e/fake/core/` — app-level E2E pairs.
- `scripts/test/e2e/real/dashboard/` and `scripts/test/e2e/fake/dashboard/` — dashboard E2E pairs.
- `scripts/test/e2e/run-suite.js` — lane runner for `real`, `fake`, or `all`.
- `scripts/test/unit/skills/` — direct executor and skill contract tests.
- `scripts/test/unit/agent/` — agent planning, routing, prompt, and state contract tests.
- `scripts/test/unit/core/` — storage, config, migrations, utility, and process contract tests.
- `scripts/test/unit/dashboard/` — dashboard static/UI parser contract tests.
- `scripts/test/support/` — shared runners, judges, fixtures, and helpers.

## Internal contract tests

Tests that verify **pure logic** (session day keys, config normalization, HTML layout, executor guards in isolation) may call functions directly. They are **not** user E2E. User-facing behavior must go through an entry point above.

## Expect modes (`behavior` vs `actual`)

See **[E2E_EXPECT.md](E2E_EXPECT.md)** and `e2e-expect.js`.

## Skill test inputs

Each skill folder has an `inputs.md` listing **user messages** the E2E uses. Those strings must match the test file and must read like real chat (no skill/tool names unless testing a slash command). Sub-agent `SOUL.md` / fixture text may pin expected answers for stability; that is not a user message.

| Folder | Test file | Entry |
|--------|-----------|--------|
| [cron/](cron/inputs.md) | `scripts/test/e2e/real/skills/test-cron-e2e.js` | `--test` |
| [agent/](agent/inputs.md) | `scripts/test/e2e/real/agent/test-agent.js` | `--test` |
| [agent-team/](agent-team/inputs.md) | `scripts/test/e2e/real/agent/test-agent-team-e2e.js` | `--test` + dashboard |
| [evaluate-team-capability/](evaluate-team-capability/inputs.md) | `scripts/test/unit/agent/test-evaluate-team-capability.js` | direct (routing logic) |
| - | `scripts/test/unit/agent/test-delegation-llm-router.js` | direct (LLM hybrid router; mock LLM) |
| [agent-team/](agent-team/inputs.md) | `scripts/test/unit/agent/test-agent-config.js` | direct (config only; replaces deleted `test-agent-team-flow.js`) |
| [basic/](basic/inputs.md) | `scripts/test/e2e/real/core/test-basic-e2e.js` | `--test` |
| [casual-greetings/](casual-greetings/inputs.md) | `scripts/test/e2e/real/agent/test-casual-greetings.js` | unit + `--test` |
| - | `scripts/test/unit/core/test-chat-session.js` | direct (session logic only) |
| [edit/](edit/inputs.md) | `scripts/test/e2e/real/skills/test-edit-e2e.js` | `--test` |
| [write/](write/inputs.md) | `scripts/test/e2e/real/skills/test-write-e2e.js` | `--test` |
| [browser/](browser/inputs.md) | `scripts/test/e2e/real/skills/test-browser-e2e.js` | `--test` |
| [memory/](memory/inputs.md) | `scripts/test/e2e/real/skills/test-memory-e2e.js` | `--test` |
| [me/](me/inputs.md) | `scripts/test/e2e/real/skills/test-me-e2e.js` | `--test` |
| [home-assistant/](home-assistant/inputs.md) | `scripts/test/e2e/real/skills/test-home-assistant-e2e.js` | `--test` |
| [vision/](vision/inputs.md) | `scripts/test/e2e/real/skills/test-vision-e2e.js` | `--test` |
| [apply-patch/](apply-patch/inputs.md) | `scripts/test/e2e/real/skills/test-apply-patch-e2e.js` | `--test` |
| [read/](read/inputs.md) | `scripts/test/e2e/real/skills/test-read-e2e.js` | `--test` |
| [go-read/](go-read/inputs.md) | `scripts/test/e2e/real/skills/test-go-read-e2e.js` | `--test` |
| [core/](core/inputs.md) | `scripts/test/e2e/real/skills/test-core-e2e.js` | `--test` |
| [go-write/](go-write/inputs.md) | `scripts/test/e2e/real/skills/test-go-write-e2e.js` | `--test` |
| [search/](search/inputs.md) | `scripts/test/e2e/real/skills/test-search-e2e.js` | `--test` |
| [server-inspect/](server-inspect/inputs.md) | `scripts/test/e2e/real/skills/test-server-inspect-e2e.js` | `--test` |
| [speech/](speech/inputs.md) | `scripts/test/e2e/real/skills/test-speech-e2e.js` | `--test` |
| [gog/](gog/inputs.md) | `scripts/test/e2e/real/skills/test-gog-e2e.js` | `--test` |
| [tide/](tide/inputs.md) | `scripts/test/unit/agent/test-tide.js` | direct (payload) |
| - | `scripts/test/unit/agent/test-work-mode.js` | direct (LLM-stubbed; chat-session storage + md-llm runner + work-mode classifier; pins "toggle takes effect next turn" contract) |
| - | `scripts/test/unit/agent/test-autonomy-gating.js` | direct (mission engine + system pulse only start once the first mission is created or already on disk; idempotent) |
| [project-workflow-e2e/](project-workflow-e2e/inputs.md) | `scripts/test/e2e/real/core/test-project-workflow-e2e.js` | `--test` (multi-turn) |

### Dashboard Tests panel (all `scripts/test/<id>/inputs.md` + matching script)

Discovery rule: folder `scripts/test/<id>/inputs.md` plus a matching script under `scripts/test/unit/**` or `scripts/test/e2e/**`. Restart the dashboard after adding suites.

| ID | Script | In UI |
|----|--------|-------|
| agent, agent-team, agent-config, agent-map-ui | mixed | ✅ |
| apply-patch, apply-patch-unit | E2E + unit | ✅ |
| background-tasks, basic, browser, calendar-skill, chat-session | unit / E2E | ✅ |
| conversation-context, core, credential-utils, cron, dry-run | unit / E2E | ✅ |
| e2e-expect, edit, fixture-state, github-skill, gmail-skill, go-read, go-write, gog | unit / E2E | ✅ |
| home-assistant, home-assistant-format, intent-planner, me, memory | unit / E2E | ✅ |
| memory-index-files, output-parse, read, retrospective, search, server-inspect | unit / E2E | ✅ |
| session-bootstrap, skill-install, speech, telegram-send, tide, tide-checklist | unit / E2E | ✅ |
| update-build, vision, workspace-chat-days, workspace-path, write | unit / E2E | ✅ |
| project-workflow-e2e | E2E (multi-turn) | ✅ |
| dashboard-boot, dashboard-browser | static + Playwright | — |

Not in UI (wrappers only): `scripts/test/e2e/real/agent/test-agent-send.js`, `scripts/test/e2e/real/agent/test-agent-title.js` → run `scripts/test/e2e/real/agent/test-agent-team-e2e.js` via pnpm aliases.
