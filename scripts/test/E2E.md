# E2E Tests: What We Test

E2E tests in this folder validate **the project’s skills** — not external APIs, tokens, or connectivity.

## What we are testing

1. **Talking to the LLM** — The main app receives the user message and the primary LLM chooses the right skill and produces a reply.
2. **Skill behavior** — The skill runs (loads config/env, calls tools or external services as designed), and the reply reflects that outcome.
3. **Whether the user got what they wanted** — A **separate LLM judge** reads the user message and the bot’s reply and answers: *Did the user get what they wanted?* No code assertions on exact wording or APIs; the judge decides.

## What we are NOT testing

- **External API validity** — We do not assert that a third-party API (e.g. Home Assistant, news, weather) is “correct” or that tokens/URLs are valid.
- **Network or auth** — We do not test that the network is up or that API keys are correct; we test that **our skill** behaves correctly given whatever the environment provides (real HA, real cron store, etc.).
- **Exact strings or regex** — We avoid brittle assertions on reply text; the judge evaluates meaning and user satisfaction.

## Flow (every E2E skill test)

```
User message  →  Main app (LLM + skill)  →  Reply
                     ↓
              Separate LLM judge: “Did the user get what they wanted?”
                     ↓
              Pass / Fail
```

- **Main app**: one process run (e.g. `node index.js --test "user message"`). We capture the reply between `E2E_REPLY_START` and `E2E_REPLY_END`.
- **Judge**: a different LLM call (same or separate process) with a prompt that includes the user message and the bot reply. Judge answers YES/NO (+ short reason). Test passes only if the judge says the user got what they wanted.

## Applying this to all E2E tests

Every E2E test that checks “did the skill do the right thing for the user?” should:

1. Run the main app with the user message and capture the reply.
2. Call the shared judge (or a skill-specific judge) with that user message and reply.
3. Pass only if the judge says the user got what they wanted.

Tests that verify **internal contracts** (e.g. cron store has exactly one job after one add, run-job stdout format, one-shot scheduling) can keep code assertions; the skill-facing behavior should go through the judge.

See individual test files for skill-specific judge prompts and setup.

## Skill test inputs

Each skill test has its own folder with an **inputs.md** that lists the test file name and inputs:

| Folder | Test file | Open for |
|--------|-----------|----------|
| [cron/](cron/inputs.md) | `test-cron-e2e.js` | List/add/recurring/manage queries |
| [tide/](tide/inputs.md) | `test-tide.js` | Payload (jid, historyMessages) |
| — | `test-tide-checklist.js` | Checklist CRUD, prompt normalization, legacy item migration |
| — | `test-chat-session.js` | Daily boundary, manual new session, log filter |
| [agent/](agent/inputs.md) | `test-agent.js` | Scenario messages |
| [edit/](edit/inputs.md) | `test-edit-e2e.js` | Edit target file + queries |
| [write/](write/inputs.md) | `test-write-e2e.js` | Write queries |
| [browser/](browser/inputs.md) | `test-browser-e2e.js` | News / non-news / search queries |
| [memory/](memory/inputs.md) | `test-memory-e2e.js` | Store phrase + recall query |
| [me/](me/inputs.md) | `test-me-e2e.js` | Me/memory queries |
| [home-assistant/](home-assistant/inputs.md) | `test-home-assistant-e2e.js` | HA queries |
| [vision/](vision/inputs.md) | `test-vision-e2e.js` | Generate image queries |
| [apply-patch/](apply-patch/inputs.md) | `test-apply-patch-e2e.js` | Patch/add/replace file |
| [read/](read/inputs.md) | `test-read-e2e.js` | Read file contents |
| [go-read/](go-read/inputs.md) | `test-go-read-e2e.js` | ls, pwd, cat |
| [core/](core/inputs.md) | `test-core-e2e.js` | ls, pwd, cat |
| [go-write/](go-write/inputs.md) | `test-go-write-e2e.js` | touch, cp |
| [search/](search/inputs.md) | `test-search-e2e.js` | Search / weather / time |
| [speech/](speech/inputs.md) | `test-speech-e2e.js` | Synthesize / reply as voice |
| [gog/](gog/inputs.md) | `test-gog-e2e.js` | Calendar / Gmail |
