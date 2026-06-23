# Pasture Protocol — Architectural Principles for Agents

> This file is for any AI or human contributor making changes to this codebase. Read it before writing or modifying code.

## The core principle: MD + LLM, JS as substrate

Pasture Protocol is a **prompt-driven** system. Almost everything the agent decides is determined by prompts written in Markdown and evaluated by an LLM at runtime. The JavaScript code is the **substrate**: it loads MD files, calls the LLM, talks to disk / network / channels, runs cron, persists state. JS is the executor and the router. It is not the brain.

### What goes in `.md`

Anything that involves *understanding the user, making a decision, planning, classifying, routing, or generating natural-language output*. Examples:

- Intent classification ("is the user toggling work mode?", "is this a casual greeting?", "is this a request to start a new session?")
- Routing ("which agent should handle this?", "is delegation appropriate?")
- Planning ("which skills should we load for this turn?", "what should we check before answering?")
- Synthesis ("how should the final reply read?")
- Persona / soul / identity prompts

These live in `lib/agent/templates/*.md` (or `skills/<skill>/SKILL.md`) and are read at runtime.

### What goes in `.js`

Only mechanical work. Examples:

- File I/O (read/write disk)
- Network calls (Telegram, WhatsApp, HTTP, browser automation)
- LLM client wrappers (`llm.js`)
- Process / daemon / cron runners
- SQLite / JSON persistence
- Schema validation (using JSON parse, not natural-language interpretation)
- Tool execution (the `executeSkill` runtime)
- Test scaffolding

### Things that are NOT allowed in JS

- **Regex on user text.** Ever. If you find yourself matching a phrase, intent, or natural-language meaning with a regex, that's a decision — it must move to an MD prompt + LLM call.
- **Keyword Sets / arrays.** Same reason. Word-list lookups against user text encode a decision.
- **`if`/`switch` branches on user text content.** Branching by language / phrasing / intent belongs in the prompt.
- **String matching for intent** (`text.includes('hello')`, `text.startsWith('/cmd')`, etc.). The LLM decides what the user means.

Regex IS fine for parsing **structured** output the system itself produced (LLM JSON, file paths, log timestamps, tool result envelopes). The rule is about *understanding the user*, not parsing.

## How to add a new decision

1. Write the decision as a prompt in `lib/agent/templates/<name>.md`. The prompt should say:
   - What the LLM is deciding
   - The exact JSON shape to return
   - What each enum value means
   - A few examples (good practice; these are part of the prompt)
2. Add a thin (~30 line) JS wrapper that:
   - Loads the MD prompt
   - Calls the LLM via `lib/agent/md-llm.js` (the generic runner)
   - Validates the parsed JSON against the expected shape
   - Returns the result, or `null` on failure (callers degrade gracefully)
3. Use that wrapper at the call site. The call site does **not** branch on the user's words; it branches on the wrapper's structured output.

## Migration status

This codebase predates the principle. A migration is in progress. See `docs/MIGRATION_TO_MD.md` for the inventory of JS decision-makers that still need to move to MD.

When you touch any file listed in that inventory, prefer to migrate it as part of your change rather than adding more JS-based logic on top.

## The work-mode example (canonical pilot)

Look at how work-mode is implemented:

- `lib/agent/templates/work-mode-classifier.md` — the prompt that decides enable / disable / no_change
- `lib/agent/work-mode.js` — the thin JS wrapper
- `lib/context/chat-session.js` — pure storage (no NL understanding)
- `index.js` — gates the multi-agent pipeline on `getSessionWorkMode(logKey)`

This is the shape every other decision in the system should take.
