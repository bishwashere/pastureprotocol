# cowCode

<div align="center">
  <img width="320" height="320" alt="cowCode" src="https://github.com/user-attachments/assets/7d245e10-8172-4956-bc29-aaba9e30aa10" />
</div>

**cowCode — your private AI companion**

Runs on your computer. Connects to WhatsApp and Telegram. Uses a local or cloud LLM of your choice. No external routing — your chats stay on your machine.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [Requirements](#requirements)
3. [Installation](#installation)
4. [WhatsApp Auth Setup (Baileys)](#whatsapp-auth-setup-baileys)
5. [Telegram Setup](#telegram-setup)
6. [Configuration Reference](#configuration-reference)
7. [Environment Variables](#environment-variables)
8. [Command Reference](#command-reference)
9. [Skills Reference](#skills-reference)
10. [Cron / Reminder Store (SQLite-free JSON store)](#cron--reminder-store)
11. [Memory Store (SQLite + vector search)](#memory-store-sqlite--vector-search)
12. [Tide (follow-up after silence)](#tide-follow-up-after-silence)
13. [File and Directory Layout](#file-and-directory-layout)
14. [Dashboard](#dashboard)
15. [Running as a Daemon](#running-as-a-daemon)

---

## What It Does

| Category | Capability |
|---|---|
| **Chat** | Conversational AI with full context window. Supports private chats, group chats, images, and voice notes. |
| **Reminders** | Natural-language scheduling. Recurring or one-shot. Time-zone aware. |
| **Web search** | Brave Search integration. Returns summarized results. |
| **Browser automation** | Playwright-powered browser. Navigate, click, fill forms, screenshot. |
| **Vision** | Describe images, webcam frames, or full web pages. |
| **Memory** | Semantic vector memory. Recall facts, notes, and decisions from past conversations. |
| **File ops** | Read, write, and edit files inside your workspace directory. |
| **Voice** | Transcribe voice notes (speech-to-text). Optionally reply in audio (text-to-speech). |
| **Home Assistant** | Integration with a local Home Assistant instance. |
| **SSH inspect** | Inspect remote servers over SSH. |
| **Tide** | Sends one AI-composed follow-up message after a configurable silence window. |
| **Multi-channel** | WhatsApp (Baileys) and Telegram simultaneously. |
| **Multi-agent** | Multiple agent personas configurable via Markdown files. |

---

## Requirements

- **Node.js 18+** (LTS recommended)
- **pnpm 9** (`npm install -g pnpm@9`)
- **Local LLM** (recommended for privacy):
  - [LM Studio](https://lmstudio.ai) — download a model and start the local server
  - [Ollama](https://ollama.ai) — `ollama serve`
- **Or a cloud API key**: OpenAI, Anthropic, Grok (xAI), Together AI, or DeepSeek
- **Playwright browsers** (for the `browse` and `vision` skills): installed automatically on first use, or run `npx playwright install chromium`

---

## Installation

### Option A — One-line install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/bishwashere/cowCode/master/install.sh | bash
```

This installs cowCode, registers the `cowcode` CLI command, and puts runtime data in `~/.cowcode`.

**Windows:** Use Git Bash and Node.js. Run `bash install.sh` inside the repo.

After install:

```bash
cowcode start      # start the bot
cowcode dashboard  # open the local web dashboard
cowcode logs       # tail daemon logs
cowcode update     # pull the latest version
cowcode uninstall  # remove cowCode
```

### Option B — From a git clone

```bash
git clone https://github.com/bishwashere/cowCode.git
cd cowCode
pnpm install
node setup.js      # interactive first-run setup
```

---

## WhatsApp Auth Setup (Baileys)

cowCode uses [Baileys](https://github.com/WhiskeySockets/Baileys), a WhatsApp Web reverse-engineered client. Authentication uses WhatsApp's multi-device protocol and is stored in `~/.cowcode/auth_info/`.

### First-time linking

```bash
# Using the installed CLI:
cowcode auth

# Or directly from the repo:
node index.js --auth-only
```

A QR code appears in your terminal. Open WhatsApp on your phone:

1. Go to **Settings → Linked Devices → Link a Device**.
2. Scan the QR code.
3. Wait for "Connection Successful" in the terminal.
4. Press `Ctrl+C` — auth files are saved and reused on every subsequent start.

### Pairing code (alternative to QR)

If you cannot scan a QR code (e.g., headless server):

```bash
node index.js --auth-only --pair <your-phone-number>
# Example: node index.js --auth-only --pair +12025550123
```

WhatsApp will send a pairing code to that number. Enter it in **Settings → Linked Devices → Link with phone number**.

### Auth file location

```
~/.cowcode/auth_info/
├── creds.json           # identity keys and registration info
└── *.json               # session, pre-keys, sender-key records
```

These files are your WhatsApp session. Back them up. Do not commit them to git (the `.gitignore` excludes `auth_info/` at the repo root).

### Re-linking

If your session expires or you get logged out, delete the auth files and run `--auth-only` again:

```bash
rm -rf ~/.cowcode/auth_info/
cowcode auth
```

---

## Telegram Setup

1. Message [@BotFather](https://t.me/BotFather) on Telegram and create a bot. Copy the token.
2. Add the token to your config:

```json
// ~/.cowcode/config.json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_TELEGRAM_BOT_TOKEN"
    }
  }
}
```

3. Start cowCode. The bot will begin polling for Telegram messages.

For group chats, add the bot to a Telegram group. The bot only responds to messages from the configured owner or groups it has been explicitly added to.

---

## Configuration Reference

All configuration lives in `~/.cowcode/config.json`. The full structure:

```jsonc
{
  "agents": {
    "defaults": {
      "userTimezone": "auto",   // "auto" detects from system, or use IANA tz e.g. "America/New_York"
      "timeFormat": "auto"      // "auto", "12h", or "24h"
    }
  },

  "llm": {
    "maxTokens": 2048,          // max tokens per LLM response
    "models": [
      // Local model (LM Studio) — used by default
      {
        "provider": "lmstudio",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "model": "local",
        "apiKey": "not-needed"
      },
      // Cloud model with priority flag — used first if available
      {
        "provider": "openai",
        "apiKey": "LLM_1_API_KEY",  // env var name or literal key
        "model": "gpt-4o",
        "priority": true
      },
      // Other cloud providers — used as fallback
      { "provider": "grok",      "apiKey": "LLM_2_API_KEY" },
      { "provider": "anthropic", "apiKey": "LLM_3_API_KEY", "model": "claude-3-5-sonnet-20241022" }
    ]
  },

  "skills": {
    "enabled": ["cron", "search", "browse", "vision", "memory"],
    "available": ["cron", "search", "browse", "vision", "memory", "gog", "read", "write", "edit", "apply-patch"],
    "search": {
      "provider": "brave",  // only "brave" is currently supported
      "count": 8            // number of search results to return
    },
    "github": {
      "token": "GITHUB_TOKEN",      // env var name or literal PAT (repo scope for private repos)
      "defaultRepo": "owner/repo"   // optional default repo used when agent omits repo
    },
    "gog": {
      "account": "you@gmail.com"    // default Google account for gmail + calendar skills
    }
  },

  "channels": {
    "whatsapp": { "enabled": true },
    "telegram": {
      "enabled": false,
      "botToken": "TELEGRAM_BOT_TOKEN"  // env var name or literal token
    }
  },

  "owner": {
    "whatsappJid": "1234567890@s.whatsapp.net",  // optional: your WhatsApp JID
    "telegramUserId": 123456789                   // optional: your Telegram user ID
  },

  "tide": {
    "enabled": false,
    "silenceCooldownMinutes": 30,  // minutes of silence before sending a follow-up
    "healthCheckMinutes": 2,       // how often Tide wakes for polling watchdog + due follow-ups (≤ cooldown)
    "jid": "",                     // target JID/chat ID; auto-detected if empty
    "inactiveStart": "23:00",      // quiet hours start (local time)
    "inactiveEnd": "06:00",        // quiet hours end (local time)
    "checklist": { "enabled": false, "triggers": { "onRestart": true, "onCycle": true, "onFollowUp": false }, "items": [] }
  }
}
```

### LLM model priority

When multiple models are configured, cowCode selects in this order:
1. Any model with `"priority": true` — used first if the provider is reachable.
2. Local providers (`lmstudio`, `ollama`) — used next as a privacy-preserving fallback.
3. Other cloud models — used in order of appearance as further fallbacks.

### Supported providers

| Provider | `"provider"` value | Notes |
|---|---|---|
| LM Studio | `lmstudio` | Local; default `baseUrl`: `http://127.0.0.1:1234/v1` |
| Ollama | `ollama` | Local; default `baseUrl`: `http://127.0.0.1:11434/v1` |
| OpenAI | `openai` | Cloud; default model: `gpt-5.2` |
| Anthropic | `anthropic` | Cloud; default model: `claude-sonnet-4-5-20250929` |
| Grok / xAI | `grok` or `xai` | Cloud; default model: `grok-4-1-fast-reasoning` |
| Together AI | `together` | Cloud; default model: `Llama-3.3-70B-Instruct-Turbo` |
| DeepSeek | `deepseek` | Cloud; default model: `deepseek-chat` |

---

## Environment Variables

Environment variables live in `~/.cowcode/.env`. Keys referenced in `config.json` (e.g. `"apiKey": "LLM_1_API_KEY"`) are resolved from this file automatically.

```env
# LLM API keys (referenced by name in config.json)
LLM_1_API_KEY=sk-...          # OpenAI API key
LLM_2_API_KEY=xai-...         # Grok/xAI API key
LLM_3_API_KEY=sk-ant-...      # Anthropic API key

# Search
BRAVE_API_KEY=BSA...           # Brave Search API key (for the search skill)

# Telegram
TELEGRAM_BOT_TOKEN=123:ABC...  # Telegram bot token (referenced in config.json)

# Optional overrides
COWCODE_STATE_DIR=             # Override state dir (default: ~/.cowcode)
OPENAI_MODEL=gpt-4o            # Override default model for a provider
GROK_MODEL=grok-3              # Override default Grok model
ANTHROPIC_MODEL=claude-3-haiku-20240307
```

---

## Command Reference

### CLI commands (after install)

```bash
cowcode start       # Start the bot in the background
cowcode stop        # Stop the background bot process
cowcode restart     # Restart the bot
cowcode status      # Show whether the bot is running
cowcode logs        # Tail the daemon log
cowcode auth        # WhatsApp QR/pairing auth (stops bot first)
cowcode dashboard   # Open the local web dashboard
cowcode update      # Pull and install the latest version
cowcode uninstall   # Remove cowCode and the CLI command

# Tide checklist — see [Tide checklist](#tide-checklist-maintenance)
cowcode tide checklist list|add|remove|run|on|off|triggers|enable|disable

# Agents, skills, servers, memory index
cowcode create agent <name>          # New agent persona
cowcode delete agent <name> [--yes]
cowcode add <skill-id>               # Install + enable a skill
cowcode index [--source memory|filesystem] [--root <path>]
cowcode server add|use|list|remove   # SSH inspect targets
```

### What you can say to the bot

#### Reminders

| Message | Effect |
|---|---|
| `remind me in 5 minutes` | One-shot reminder in 5 minutes |
| `remind me tomorrow at 9am` | One-shot reminder next day at 9:00 |
| `every Monday at 8am remind me to standup` | Recurring weekly cron reminder |
| `every day at 7pm remind me to log my hours` | Recurring daily reminder |
| `list my reminders` | Lists all active reminders with their IDs |
| `cancel reminder 2` | Cancels the reminder with id 2 |
| `what's scheduled?` | Shows upcoming reminders |

#### Web search

| Message | Effect |
|---|---|
| `search for AI trends` | Brave Search, returns a summary |
| `what's the weather in London?` | Live search + summary |
| `find news about X` | News search |

#### Browser

| Message | Effect |
|---|---|
| `open example.com and tell me what's there` | Navigates and describes |
| `go to that URL, click the login button` | Clicks an element |
| `fill the form and submit` | Form automation |
| `screenshot the page` | Returns a screenshot |
| `scroll down and find the pricing section` | Scroll + locate |

#### Vision

| Message | Effect |
|---|---|
| `describe this image` | Analyzes an attached image |
| `what's on that page?` | Describes a screenshot or URL |
| `what do you see?` (with webcam) | Captures and describes webcam frame |

#### Memory and files

| Message | Effect |
|---|---|
| `remember that the API key is XYZ` | Saves to semantic memory |
| `what did I note about the project?` | Semantic recall |
| `what did we decide yesterday?` | Recall by recency |
| `summarize my notes` | Summarizes workspace MEMORY.md |
| `read main.py` | Reads a file in the workspace |
| `save this to notes.md` | Creates or appends to a file |
| `list files in my workspace` | Lists the workspace directory |
| `in config.json replace "debug": false with "debug": true` | Patch-edits a file |

---

## Skills Reference

Skills are modular capabilities. They are listed in `config.json` under `skills.enabled`. Disabling a skill removes it from the agent's tool set.

| Skill ID | What it does | Key dependency |
|---|---|---|
| `cron` | Natural-language reminder scheduling (recurring + one-shot) | croner |
| `search` | Web search via Brave Search API | BRAVE_API_KEY |
| `browse` | Headless browser automation | Playwright / Chromium |
| `vision` | Image and webcam analysis | LLM with vision support, or vision fallback model |
| `memory` | Semantic memory indexing and recall | sqlite-vec (vector extension) |
| `read` | Read files from the workspace | — |
| `write` | Create or overwrite workspace files | — |
| `edit` | Patch-edit workspace files (targeted find/replace) | — |
| `apply-patch` | Apply unified diffs to workspace files | — |
| `gog` | Google Workspace CLI (Gmail, Calendar, Drive, etc.) | `gog` CLI |
| `gmail` | Gmail — list, read, search, send, archive, summarize | `gog` CLI |
| `calendar` | Google Calendar — list, create, delete, check availability | `gog` CLI |
| `github` | GitHub — repos, issues, PRs, branches, comments | `GITHUB_TOKEN` |
| `me` | Self-reflective memory about the agent's identity | — |
| `go-read` | Read files from arbitrary paths (outside workspace) | — |
| `go-write` | Write files to arbitrary paths (outside workspace) | — |
| `home-assistant` | Control Home Assistant entities | Home Assistant instance |
| `ssh-inspect` | Inspect and query remote servers over SSH | SSH access |
| `speech` | Voice transcription and synthesis | Speech provider config |

Skill files live in `skills/<id>/SKILL.md` and define the prompts and executor logic for each skill.

---

## Cron / Reminder Store

Reminders are stored in plain JSON at `~/.cowcode/cron/jobs.json` (no SQLite dependency for the scheduler). The store is human-readable and can be edited manually.

### Schema

```jsonc
{
  "version": 1,
  "jobs": [
    {
      "id": "abc123",          // Unique job ID (UUID)
      "name": "standup",       // Human-readable name
      "enabled": true,
      "schedule": {
        // Recurring: cron expression
        "kind": "cron",
        "expr": "0 8 * * 1",   // Every Monday at 08:00
        "tz": "America/New_York"
      },
      // OR one-shot:
      // "schedule": { "kind": "at", "at": "2026-06-01T09:00:00Z" }
      "message": "Remind me to run the standup",  // Sent to LLM as the prompt
      "jid": "1234567890@s.whatsapp.net",          // Reply channel (WhatsApp JID or Telegram chat id)
      "createdAtMs": 1716000000000,
      "updatedAtMs": 1716000000000,
      "sentAtMs": null     // Set when a one-shot has been delivered (prevents duplicates after restart)
    }
  ]
}
```

Cron expressions use standard 5-field format: `minute hour day month weekday`. The `tz` field accepts any IANA timezone string.

---

## Memory Store (SQLite + vector search)

Semantic memory is stored in a SQLite database with the [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension for vector similarity search.

**Location:** `~/.cowcode/memory/` (or inside `workspace/memory/` depending on configuration)

### How memory works

1. When memory is enabled, each message exchange is indexed into SQLite from **chat-log** (`chat-log/YYYY-MM-DD.jsonl` and `chat-log/private/*.jsonl`). Long-term notes in **MEMORY.md** (and optional custom `memory/*.md` files like `preferences.md`) are indexed too.
2. Legacy date-stamped `memory/YYYY-MM-DD.md` files are **not** indexed — daily history lives in chat-log only.
3. On each new message, the bot runs a similarity search against stored memories and prepends relevant past context to the system prompt.
4. Explicit save commands (`"remember that..."`, `"save this to notes"`) append to `MEMORY.md`.

### Key files

| File | Contents |
|---|---|
| `memory.db` | SQLite database with `sqlite-vec` vector index |
| `MEMORY.md` | Human-readable notes file (read/written by the `write` and `memory` skills) |
| `preferences.md` | Persistent user preferences (referenced by the `me` skill) |

### Chat logs

Chat history is written to plain text files in `~/.cowcode/workspace/` so you can search them with any text tool. Private and group chats are stored separately.

### Chat sessions (backend)

LLM context is scoped to a **session** per chat (owner log, per-DM jid, or group). Full logs still append to the same JSONL files with a `sessionId` field.

- **Daily reset** — New session at **03:00** in `agents.defaults.userTimezone` (same timezone as reminders; `"auto"` uses the host TZ). Override hour with `agents.defaults.sessionResetHour` (0–23).
- **Manual reset** — Say e.g. `start a new session`, `new session`, or `/new-session` (no special reply text; context simply clears).
- **State file** — `~/.cowcode/chat-sessions/state.json`
- **Bootstrap (not in session history)** — On each **new session**, daemon **restart**, and every **Tide** follow-up, the model receives `MEMORY.md` plus **today and yesterday’s chat logs** (`chat-log/YYYY-MM-DD.jsonl` and, for private chats, `chat-log/private/<jid>.jsonl`). Chat session history stays scoped to the current session only.

---

## Tide (follow-up after silence)

Tide sends a single AI-composed follow-up message when a conversation goes quiet. It reads the recent conversation context and generates a short, relevant nudge ("Tests passed — what's next?" / "Still no reply on that, should I follow up?").

```json
// ~/.cowcode/config.json
{
  "tide": {
    "enabled": true,
    "silenceCooldownMinutes": 60,  // minimum silence before a follow-up is sent
    "healthCheckMinutes": 2,       // polling watchdog + follow-up scheduler interval (default 2)
    "inactiveStart": "23:00",      // quiet hours start — no Tide during this window
    "inactiveEnd": "06:00",        // quiet hours end
    "jid": ""                      // leave empty for auto-detection
  }
}
```

Tide never sends more than one follow-up per silence period, and never during the configured quiet hours. Each cycle also runs the Telegram polling watchdog (self-healing heartbeat), independent of whether a follow-up is sent.

### Tide checklist (maintenance)

Tide can run a configurable **checklist** of prompts. Each item is **one agent turn** (same skills and bootstrap context as chat)—executed **one by one** in order. Prior item results are passed as context to the next. Results are logged only (`~/.cowcode/tide-checklist-last.json`), not sent to the user.

**Item schema:** `id`, `label`, `prompt`, `enabled`. The agent should end with `OK:` or `FAIL:`; anything else is treated as pass unless it starts with `FAIL`.

**Automatic runs** need `tide.enabled` + `checklist.enabled` + the trigger on + outside quiet hours. **Manual runs** (`cowcode tide checklist run` or dashboard **Run now**) ignore those flags.

| Trigger | When it runs |
|---|---|
| `onRestart` | Daemon starts |
| `onCycle` | Each Tide health-check interval |
| `onFollowUp` | Before a follow-up message is sent for a chat |

```json
"checklist": {
  "enabled": true,
  "triggers": { "onRestart": true, "onCycle": true, "onFollowUp": false },
  "items": [
    {
      "id": "time-check",
      "label": "Local time",
      "prompt": "What is the current local time? Report OK or FAIL.",
      "enabled": true
    }
  ]
}
```

Fresh installs get a default **Telegram polling health** item (disabled until you enable the checklist).

**CLI**

```bash
cowcode tide checklist list
cowcode tide checklist add "Local time" --prompt "What is the current local time?"
cowcode tide checklist remove <id>
cowcode tide checklist enable|disable <id>
cowcode tide checklist on|off
cowcode tide checklist run [--id <id>]
cowcode tide checklist triggers [--on-restart|--no-on-restart] [--on-cycle|--no-on-cycle] [--on-follow-up|--no-on-follow-up]
```

**Dashboard:** **Tide** page — toggle Tide/checklist, edit triggers and items, run manually, view last results. Legacy `shell`/`http`/`builtin` config items are auto-converted to prompts on load.

---

## File and Directory Layout

### Runtime state (`~/.cowcode/`)

```
~/.cowcode/
├── config.json              # Main configuration
├── .env                     # API keys and env var overrides
├── daemon.log               # Bot daemon stdout log
├── daemon.err               # Bot daemon stderr log
├── auth_info/               # WhatsApp session files (Baileys)
│   ├── creds.json
│   └── *.json
├── chat-sessions/
│   └── state.json           # Per-chat session IDs (daily reset)
├── cron/
│   └── jobs.json            # Reminder/cron job store
├── tide-checklist-last.json # Last Tide checklist run summary
├── projects.db              # Dashboard Projects tracker (SQLite)
├── workspace/               # Default workspace for file operations
│   ├── MEMORY.md            # User notes (read/written by skills)
│   ├── memory/              # Daily logs + vector memory store
│   └── ...                  # User files
└── agents/ groups/          # Per-agent and per-group config (when used)
```

### Code (`~/.local/share/cowcode/` or clone root)

```
cowCode/
├── index.js                 # Entry point — connects WhatsApp + Telegram, routes messages
├── llm.js                   # LLM provider loader and multi-model fallback logic
├── cli.js                   # CLI command dispatcher
├── setup.js                 # Interactive first-run setup wizard
├── lib/
│   ├── agent.js             # Agent turn runner (tool call loop)
│   ├── intent-planner.js    # Classifies intent → selects skills
│   ├── system-prompt.js     # Builds the system prompt (one-on-one)
│   ├── group-prompt.js      # Builds the system prompt for groups
│   ├── telegram.js          # Telegram bot adapter (polling)
│   ├── whatsapp.js          # WhatsApp utility functions
│   ├── memory-index.js      # Memory embedding + vector search
│   ├── session-bootstrap.js # MEMORY.md bootstrap for new sessions / Tide
│   ├── chat-log.js          # Append/read conversation logs
│   ├── paths.js             # Resolves all state directory paths
│   ├── speech-client.js     # Speech-to-text / text-to-speech client
│   ├── timezone.js          # Time-zone utilities
│   ├── owner-config.js      # Owner/admin identity resolution
│   ├── tide-checklist.js    # Tide maintenance checklist (agent turns)
│   └── executors/           # Skill execution engines (browse, vision, etc.)
├── skills/
│   ├── browse/              # Playwright browser skill
│   ├── cron/                # Reminder scheduling skill
│   ├── memory/              # Semantic memory skill
│   ├── search/              # Web search skill (Brave)
│   ├── vision/              # Image/webcam vision skill
│   ├── read/ write/ edit/   # File operation skills
│   └── loader.js            # Skill registry loader
├── cron/
│   ├── runner.js            # Cron job runner (croner-based scheduler)
│   ├── store.js             # Read/write jobs.json
│   └── cli.js               # Cron management CLI
├── dashboard/
│   └── server.js            # Local Express web dashboard
└── workspace-default/       # Default workspace template files
    ├── SOUL.md              # Agent personality template
    ├── WhoAmI.md            # Agent identity template
    └── MyHuman.md           # User profile template
```

---

## Dashboard

Local Express web UI for chat, config, and ops.

```bash
cowcode dashboard
# or:
node dashboard/server.js
```

Open `http://localhost:3100` (default port). Nav pages: **Chat**, **Status**, **Soul**, **Crons**, **Skills**, **Agents**, **Groups**, **LLM**, **Tide** (checklist), **Config**, **Test**, **Projects**.

**Projects** — visual project tracker with branched update chains. See [docs/projects.md](docs/projects.md) for auth and API.

---

## Running as a Daemon

`cowcode start` launches the bot as a background daemon using the platform's process manager so it survives terminal sessions.

Logs are written to `~/.cowcode/daemon.log` (stderr: `daemon.err`). Tail them with:

```bash
cowcode logs
# or:
tail -f ~/.cowcode/daemon.log
```

---

## Privacy

- Runs entirely on your machine.
- WhatsApp and Telegram connect directly — no external proxy.
- Config, auth, and chats live in `~/.cowcode` — not in the code directory.
- Local models (LM Studio, Ollama) mean zero data leaves your device.
- Cloud LLMs send only the current conversation context to the provider's API — no call history is ever sent unless it is in the active context window.
- `git push` on this repo never uploads your chats, auth files, or API keys. The `.gitignore` excludes all common state layout names.
