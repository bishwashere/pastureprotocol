# Migration to MD + LLM Architecture

This is the live inventory of JavaScript code in `pastureprotocol` that currently makes **decisions about user intent or natural-language meaning** in JS. Per `AGENTS.md`, every item below should be moved to a Markdown prompt + LLM call, with JS reduced to a thin loader/wrapper. Items are ordered by **scope of impact** (smallest → largest) so we can ship incremental wins.

> Conventions
> - **Status** values: `pending` (not started), `in-progress`, `done`.
> - When migrating, drop the prompt at `lib/agent/templates/<name>.md` and the thin wrapper at `lib/agent/<name>.js`. Use `lib/agent/md-llm.js` as the runner.
> - Tests must stub the LLM via the `llmChat` test seam — never call live models from unit tests.
> - Update this file as part of the migration PR (move the row to `done`, link the PR if applicable).

## Done

| Item | Where it was | Where it is now | Status |
|---|---|---|---|
| Work-mode toggle (single vs. multi-agent) | _new feature_ | `lib/agent/templates/work-mode-classifier.md` + `lib/agent/work-mode.js` | done |
| Generic MD-prompt runner | _new_ | `lib/agent/md-llm.js` | done |
| Architectural principle | _new_ | `AGENTS.md` (repo root) | done |
| Delegation LLM router prompt | inlined string in `lib/agent/delegation-llm-router.js` | `lib/agent/templates/delegation-router.md` (called via `runMdPrompt`) | done |
| Intent-planner JS wrapper | manual `readFileSync` + LLM call + `JSON.parse` in `lib/agent/intent-planner.js` | thin call to `runMdPrompt({ promptName: 'intent-planner', ... })` | done |
| Retrospective: score exchange | inlined prompt string in `lib/agent/retrospective.js` | `lib/agent/templates/retrospective-score.md` | done |
| Retrospective: implicit feedback classifier | inlined prompt string in `lib/agent/retrospective.js` | `lib/agent/templates/retrospective-implicit-feedback.md` | done |
| System-pulse: pattern detector | inlined prompt string in `lib/agent/system-pulse.js` | `lib/agent/templates/system-pulse-pattern-detector.md` | done |
| System-pulse: self-edit safety critique | inlined prompt string in `lib/agent/system-pulse.js` | `lib/agent/templates/system-pulse-self-critique.md` | done |
| Tide-checklist instruction block | inlined template literal in `lib/agent/tide-checklist.js` | `lib/agent/templates/tide-checklist-instruction.md` | done |
| `parseWriteIntent` / `parseEditIntent` / `parseHomeAssistantListIntent` fast paths | regex parsers + bypass blocks in `lib/agent/agent.js` | **deleted** — intent-planner LLM call routes these via the normal tool loop | done |

## Tier 1 — small, isolated classifiers (start here)

These are single-purpose regex/keyword classifiers. Each can be migrated in one PR with an LLM-stubbed test.

| Item | Current location | Notes |
|---|---|---|
| `isNonTaskMessage` (greeting / casual chat) | `lib/agent/evaluate-team-capability.js` | Used by `intent-planner.js` and others to skip the planner. New MD: `casual-message-classifier.md`. **Pending.** |
| `isNewSessionRequest` / `isNewSessionOnlyRequest` | `lib/context/chat-session.js` | "Start a new session" detection. New MD: `new-session-classifier.md`. **Pending.** |
| `detectReplyModeSwitch` | `lib/context/chat-session.js` | Text-vs-voice reply mode toggle. New MD: `reply-mode-classifier.md`. Mirrors work-mode shape. **Pending.** |
| `isYesReply` (and similar) | `lib/channels/telegram.js` | Yes/no confirmations. New MD: `yes-no-classifier.md`. **Pending.** |
| `detectExplicitTargetAgent` | `lib/agent/evaluate-team-capability.js` | Token-match for explicit @-mentions. The LLM delegation router already handles this; the JS one is a precomputed hint. Migrate or remove. **Pending.** |

## Tier 2 — medium decision blocks

| Item | Current location | Notes |
|---|---|---|
| `intent-planner.js` validators | `lib/agent/intent-planner.js` (+ `templates/intent-planner-prompt.md`) | The MD prompt + `runMdPrompt` plumbing is now in place (see Done). Remaining JS: `isNonTaskMessage` shortcut, output validators, durable-mode coercion. **Pending.** |
| `getMissionsDiscoveryIntentHint` | `lib/context/missions-context.js` | Keyword/feature hint computed before the planner. Should be an MD classifier or merged into the planner output. **Pending.** |
| `getGithubSourceIntentHint` | `lib/context/github-context.js` | Same shape as above. **Pending.** |
| Tide checklist *triggers* | `lib/agent/tide-checklist.js` | Instruction block is now MD (see Done). Remaining JS: decision logic for *when* to fire a follow-up. **Pending.** |
| Curiosity-momentum prompts | `lib/agent/curiosity-momentum.js` (+ `templates/curiosity-momentum-prompt.md`) | Prompt is MD; surrounding decision wrapper is JS. Slim. **Pending.** |
| Retrospective *triggers* | `lib/agent/retrospective.js` | Score + implicit-feedback prompts are now MD (see Done). Remaining JS: decision logic for *when* to inject retrospective context into the system prompt. **Pending.** |

## Tier 3 — larger surgery

| Item | Current location | Notes |
|---|---|---|
| Work-durability classifier | `lib/context/work-durability.js` | Already partially LLM-driven (`classifyWorkDurabilityWithAi`), but has heavy JS fast paths and keyword scoring. Convert fast paths to LLM. **Pending.** |
| Delegation router | `lib/agent/agent-delegation-router.js`, `lib/agent/delegation-llm-router.js` | Hybrid scoring + LLM. Move scoring into the LLM prompt. **Pending.** |
| Forced-delegation rules | `lib/agent/forced-delegation.js` | Should follow the LLM router's recommendation; currently has its own heuristics. **Pending.** |
| User-facing reply formatter | `lib/agent/user-facing-reply.js` | Formatting logic for the final reply. Some is mechanical (markdown sanitization) and stays JS; some is editorial (which lines to keep) and moves to MD. **Pending.** |

## Tier 4 — runtime / orchestration glue

These are mostly mechanical (loops, retries, IO). They should *stay* in JS, but any embedded prompt strings or natural-language branching they still contain should move to MD prompts.

| Item | Current location | Notes |
|---|---|---|
| `agent.js` tool loop | `lib/agent/agent.js` | Mechanical retry / synthesis. Embedded prompt fragments (e.g. retry-with-tools messages) should move to MD. **Pending.** |
| Internal-agent turn runner | `lib/agent/internal-agent-turn.js` | Mechanical. Audit for embedded NL strings. **Pending.** |
| System-prompt builder | `lib/agent/system-prompt.js` | Composes MD blocks; should be pure assembly (no NL decisions). **Pending audit.** |
| Channel handlers | `lib/channels/*` | Mostly transport (good). Audit for any NL branching in router code (e.g. `isYesReply`, see Tier 1). **Pending audit.** |

## Migration recipe

For each item:

1. **Author the prompt.** Write `lib/agent/templates/<name>.md`. The prompt must declare the exact JSON output shape and include 3–5 representative input/output examples.
2. **Build the wrapper.** Thin JS in `lib/agent/<name>.js` that calls `runMdPrompt({ promptName, user })`, validates the JSON shape, and returns it. ~30 lines or fewer.
3. **Wire the call site.** Replace the regex / keyword call with the wrapper. The call site must NOT branch on user text — only on the wrapper's structured output.
4. **Add a test.** `scripts/test/test-<name>.js`. Use the `llmChat` test seam to stub the LLM. Cover: each enum value, malformed JSON, LLM throw, and (where applicable) idempotence.
5. **Register the test.** Add to `package.json` (`test:<name>`) and `scripts/test/E2E.md`.
6. **Update this file.** Move the row to `Done`. Note any follow-ups.

## Non-goals (regex stays in these places)

The architecture rule is about *understanding the user*. Regex is fine for parsing **structured** data the system itself produced:

- LLM JSON envelopes, tool-call arguments, `<think>` tag stripping.
- File paths, log timestamps, environment-variable names.
- Skill schemas and config shapes.
- Markdown sanitation (e.g. removing `**` from final replies).
- Cron expression parsing / humanizing.

If you're unsure whether a piece of regex is "understanding the user" or "parsing structured data", ask: *would the same pattern work if the user typed in a different language?* If yes, it's parsing. If no, it's understanding — migrate it.
