# cowCode

<div align="center">
  <img width="320" height="320" alt="cowCode" src="https://github.com/user-attachments/assets/7d245e10-8172-4956-bc29-aaba9e30aa10" />
</div>

**cowCode - your private AI companion**

Runs on your computer. Connects to WhatsApp and Telegram. Uses a local or cloud LLM of your choice. No external routing - your chats stay on your machine.

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
10. [GitHub Integration](#github-integration)
11. [Google Integration (Gmail & Calendar)](#google-integration-gmail--calendar)
12. [Multi-Agent (Agent Team)](#multi-agent-agent-team)
13. [Dashboard Guide](#dashboard-guide)
14. [Cron / Reminder Store (SQLite-free JSON store)](#cron--reminder-store)
15. [Memory Store (SQLite + vector search)](#memory-store-sqlite--vector-search)
16. [Tide (follow-up after silence)](#tide-follow-up-after-silence)
17. [File and Directory Layout](#file-and-directory-layout)
18. [Running as a Daemon](#running-as-a-daemon)

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
| **GitHub** | Read repos, issues, and PRs. Create branches, open PRs, post comments. |
| **Gmail** | List, read, search, send, archive, and summarize emails. |
| **Calendar** | List events, create meetings, check availability, find free slots. |
| **Multi-channel** | WhatsApp (Baileys) and Telegram simultaneously. |
| **Multi-agent** | Multiple agent personas, each with its own skills, identity, and memory. Route chats to specialists. |

---

## Requirements

- **Node.js 18+** (LTS recommended)
- **pnpm 9** (`npm install -g pnpm@9`)
- **Local LLM** (recommended for privacy):
  - [LM Studio](https://lmstudio.ai) - download a model and start the local server
  - [Ollama](https://ollama.ai) - `ollama serve`
- **Or a cloud API key**: OpenAI, Anthropic, Grok (xAI), Together AI, or DeepSeek
- **Playwright browsers** (for the `browse` and `vision` skills): installed automatically on first use, or run `npx playwright install chromium`

---

## Installation

### Option A - One-line install (recommended)

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

### Option B - From a git clone

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
4. Press `Ctrl+C` - auth files are saved and reused on every subsequent start.

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
      // Local model (LM Studio) - used by default
      {
        "provider": "lmstudio",
        "baseUrl": "http://127.0.0.1:1234/v1",
        "model": "local",
        "apiKey": "not-needed"
      },
      // Cloud model with priority flag - used first if available
      {
        "provider": "openai",
        "apiKey": "LLM_1_API_KEY",  // env var name or literal key
        "model": "gpt-4o",
        "priority": true
      },
      // Other cloud providers - used as fallback
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
1. Any model with `"priority": true` - used first if the provider is reachable.
2. Local providers (`lmstudio`, `ollama`) - used next as a privacy-preserving fallback.
3. Other cloud models - used in order of appearance as further fallbacks.

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

# Tide checklist - see [Tide checklist](#tide-checklist-maintenance)
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

#### GitHub (requires `github` skill + token)

| Message | Effect |
|---|---|
| `list open issues` | Lists open issues in the default repo |
| `show me PR #12` | Reads PR #12 with all comments |
| `create branch feat/login from main` | Creates a new branch (confirms first) |
| `open a PR from feat/login titled "Add login"` | Opens a pull request (confirms first) |
| `post a comment on issue #5: "Fixed in #9"` | Posts a comment (confirms first) |
| `merge PR #10` | Merges the PR (shows details, confirms first) |

#### Gmail (requires `gmail` skill + `gog auth`)

| Message | Effect |
|---|---|
| `what's in my inbox?` | Lists recent inbox messages |
| `show unread emails` | Filters to unread |
| `search for emails from alice@co.com` | Gmail search |
| `summarize my inbox` | Sender/subject breakdown |
| `send an email to bob@co.com about the deadline` | Composes and confirms before sending |
| `archive all emails older than 30 days` | Bulk archive (confirms first) |
| `clear my inbox` | Archives all inbox messages (confirms first) |

#### Calendar (requires `calendar` skill + `gog auth`)

| Message | Effect |
|---|---|
| `what's on my calendar today?` | Lists today's events |
| `book a 30 min meeting with john@co.com next Tuesday 2pm` | Creates event (confirms first) |
| `am I free Friday at 3pm?` | Checks free/busy |
| `find a free 1-hour slot this week` | Finds next open block |
| `delete the standup tomorrow` | Deletes event (confirms first) |

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
| `read` | Read files from the workspace | - |
| `write` | Create or overwrite workspace files | - |
| `edit` | Patch-edit workspace files (targeted find/replace) | - |
| `apply-patch` | Apply unified diffs to workspace files | - |
| `gog` | Google Workspace CLI (Gmail, Calendar, Drive, etc.) | `gog` CLI |
| `gmail` | Gmail - list, read, search, send, archive, summarize | `gog` CLI |
| `calendar` | Google Calendar - list, create, delete, check availability | `gog` CLI |
| `github` | GitHub - repos, issues, PRs, branches, comments | `GITHUB_TOKEN` |
| `me` | Self-reflective memory about the agent's identity | - |
| `go-read` | Read files from arbitrary paths (outside workspace) | - |
| `go-write` | Write files to arbitrary paths (outside workspace) | - |
| `home-assistant` | Control Home Assistant entities | Home Assistant instance |
| `ssh-inspect` | Inspect and query remote servers over SSH | SSH access |
| `speech` | Voice transcription and synthesis | Speech provider config |

Skill files live in `skills/<id>/SKILL.md` and define the prompts and executor logic for each skill.

---

## GitHub Integration

Connect cowCode to GitHub so the agent can read repositories, manage issues and PRs, create branches, post comments, and more - all through natural conversation.

### 1. Create a token

Go to **GitHub → Settings → Developer settings → Personal access tokens**.

| Use case | Recommended scopes |
|---|---|
| Read-only (public repos) | `public_repo` |
| Read/write (private repos + PRs) | `repo` |
| Issues and PR comments | `repo` → Issues + Pull requests |
| Fine-grained token (recommended) | Select the specific repository, grant Issues (R/W) + Pull requests (R/W) + Contents (R) |

**Never grant** `admin:org`, `delete_repo`, or `workflow` unless you specifically need them.

### 2. Store the token

**Option A - `secrets.json`** (recommended, gitignored):

```json
// ~/.cowcode/secrets.json
{ "github": { "token": "ghp_your_token_here" } }
```

**Option B - `.env`** file:

```env
# ~/.cowcode/.env
GITHUB_TOKEN=ghp_your_token_here
```

### 3. Optional: set a default repo

```json
// ~/.cowcode/config.json  →  skills section
"github": {
  "token": "GITHUB_TOKEN",
  "defaultRepo": "owner/repo"
}
```

When `defaultRepo` is set, you can say "list issues" without repeating the repo name every time.

### 4. Enable the skill

```json
"skills": {
  "enabled": ["github", "...other skills"]
}
```

Or toggle it on the **Skills** page in the dashboard. The badge next to the skill shows **configured** (green), **needs setup** (red), or **token in config** (yellow - move it to `secrets.json`).

### What you can say

| Message | What happens |
|---|---|
| `list open issues in myorg/myrepo` | Lists open issues |
| `show me PR #42` | Reads the PR with full comment thread |
| `what PRs are open?` | Lists open pull requests (uses defaultRepo) |
| `read the README` | Reads `README.md` from the default branch |
| `create branch feat/webhooks from main` | Creates a branch (asks to confirm) |
| `open a PR from feat/webhooks titled "Add webhooks"` | Opens a PR (asks to confirm) |
| `post a comment on issue #5 saying "Fixed in #8"` | Posts a comment (asks to confirm) |
| `merge PR #10 with squash` | Merges the PR (shows details, asks to confirm) |
| `search for "executeGithub" in my repo` | Searches code on GitHub |

All write operations (**create branch**, **post comment**, **create PR**, **merge PR**) show you exactly what will happen and ask for confirmation before proceeding.

---

## Google Integration (Gmail & Calendar)

Gmail and Calendar use the [`gog` CLI](https://gogcli.sh) - a Google Workspace command-line tool that handles OAuth. cowCode calls `gog` behind the scenes, so you only need to authenticate once.

### 1. Install gog

```bash
brew install gog        # macOS
# or: pip install gog   # Python-based install
```

### 2. Authenticate

```bash
gog auth
# Follow the browser OAuth flow. Grants Gmail + Calendar scopes.
```

### 3. Set your account (optional)

```json
// ~/.cowcode/config.json  →  skills section
"gog": {
  "account": "you@gmail.com"
}
```

Omit this if you only have one Google account. When set, all `gmail` and `calendar` tool calls use that account automatically.

### 4. Enable the skills

```json
"skills": {
  "enabled": ["gmail", "calendar", "..."]
}
```

---

### Gmail - what you can say

| Message | What happens |
|---|---|
| `what's in my inbox?` | Lists recent inbox messages |
| `show me unread emails` | Filters to unread |
| `search for emails from boss@company.com` | Searches inbox |
| `summarize my inbox` | Returns sender/subject breakdown for recent messages |
| `read that email` | Reads the full body of a selected message |
| `send an email to alice@co.com about the report` | Composes + asks to confirm before sending |
| `reply to that thread saying "Done, see PR #8"` | Replies to the thread (confirms first) |
| `archive all emails older than 30 days` | Bulk archive (confirms first) |
| `mark all unread as read` | Marks all unread messages as read |
| `clear my inbox` | Archives everything in inbox (confirms first) |

Send and reply actions **always** require explicit confirmation before executing.

---

### Calendar - what you can say

| Message | What happens |
|---|---|
| `what's on my calendar this week?` | Lists events for the next 7 days |
| `do I have anything tomorrow?` | Lists tomorrow's events |
| `book a 30-minute meeting with john@co.com next Tuesday at 2pm` | Creates event (shows details, confirms) |
| `schedule a 1-hour team sync every Monday at 10am` | Creates recurring event (confirms) |
| `am I free Friday at 3pm?` | Checks free/busy for that slot |
| `find a free 1-hour slot this week` | Finds the next available block |
| `move the 3pm standup to 4pm` | Updates the event time (confirms) |
| `delete the standup tomorrow` | Deletes the event (confirms) |
| `create an all-day event "Offsite" on June 15` | Creates an all-day event |

Create, update, and delete actions **always** require explicit confirmation. For natural-language times ("next Tuesday 2pm"), the agent converts to the correct ISO timestamp using your local timezone before calling the API.

---

## Multi-Agent (Agent Team)

cowCode supports multiple **agent personas**. Each agent has its own identity files, skill set, and optionally its own LLM config. You can route different conversations to different specialists - a coding agent, a writing agent, a personal assistant, etc.

### Concepts

| Term | Meaning |
|---|---|
| **Agent** | A named persona with its own skills, identity (WhoAmI, MyHuman), and optional LLM. |
| **`main`** | The default agent. Always exists, cannot be deleted. |
| **Agent team** | All configured agents. Visualized as a tree on the dashboard home. |
| **Agent messaging** | One agent can invoke another via the `agent-send` skill. Controlled by an allow-list. |
| **Groups** | WhatsApp/Telegram groups are assigned to a specific agent. Group members chat with that agent only. |

### Creating agents

**From the dashboard** (easiest):

1. Open the dashboard home page.
2. Click **+ Agent** (top-right of the Agent team card, or in the chat toolbar).
3. Type a **name** (e.g. "Backend Bot", "Writer"). The internal id is auto-generated (`backend-bot`, `writer`).
4. Choose **Copy settings from** - defaults to the most recently used non-main agent. This copies the LLM config, skills (minus sensitive defaults), and identity files.
5. Click **Create**. The new agent appears in the tree immediately.

**From the CLI:**

```bash
cowcode create agent backend-bot
```

### Configuring an agent

Click the **✎** button on any agent card to edit:

- **Title** - display name shown in the UI and chat toolbar
- **Skills** - toggle which skills this agent has access to (independent of the main agent)
- **Agent messaging** - enable the `agent-send` skill and add which other agents this one can invoke

### The Agent team tree

The dashboard home page shows all agents as a **tree**:

```
              [main]
             /       \
     [writer]     [backend-bot]
```

- **`main` is always the root** - it sits at the top.
- Other agents branch below it.
- **Solid lines** = tree structure (hierarchy).
- **Dashed arrows** = message-passing permission (agent A can invoke agent B).
- Click any node to switch the chat to that agent.

### Routing messages to agents

**Private chats (WhatsApp/Telegram DMs):** You select which agent handles the conversation from the chat toolbar dropdown on the dashboard, or by changing `selectedChatAgentId` in the chat UI.

**Group chats:** Assign a group to a specific agent on the **Groups** page. Every message in that group is handled by the assigned agent with its specific skills.

**Agent-to-agent messaging:** If `agent-send` is enabled and an agent has an allow-list configured, one agent can delegate tasks to another mid-conversation:

```
User: "Write a PR description and then ask the backend agent to open it"
main agent → invokes writer agent to draft → invokes backend-bot to create_pr
```

### Per-agent config files

Each agent's identity lives in `~/.cowcode/agents/<id>/workspace/`:

| File | Purpose |
|---|---|
| `SOUL.md` | Core personality - tone, style, rules |
| `WhoAmI.md` | Agent's self-description |
| `MyHuman.md` | What this agent knows about the user |

Edit these from the **Agents** page in the dashboard (select an agent → Identity files).

### Groups - assigning agents

On the **Groups** page, select a group and assign it to an agent. You can also add a **skills deny list** for that group (e.g., disable `go-write` in a shared group).

---

## Dashboard Guide

Open the dashboard with:

```bash
cowcode dashboard
# Opens http://127.0.0.1:3847
```

### Pages

| Page | What it's for |
|---|---|
| **Home** | Chat with any agent. Status overview. Agent team tree. |
| **Memory** | Browse and edit all memory: Today, Yesterday, Long-term (MEMORY.md), History, Notes. |
| **Crons** | View, add, and delete scheduled reminders. |
| **Skills** | Enable/disable skills. View credential status badges. Edit SKILL.md files inline. |
| **Agents** | Create and configure agent personas. Edit identity files. |
| **Groups** | Assign WhatsApp/Telegram groups to agents. Set per-group skill restrictions. |
| **LLM** | Configure language models, providers, API keys, and fallback priority. |
| **Tide** | Enable/disable Tide follow-ups. Manage the maintenance checklist. |
| **Config** | Full raw JSON config editor with live preview. |
| **Test** | Run built-in skill tests (search, browser, memory, etc.) directly from the UI. |
| **Projects** | Visual project tracker with branched updates. |

---

### Home page

The home page has two panels:

**Left - Overview & Identity:**
- Live status (daemon up/down, active model, skill count, timezone)
- Identity tiles: click **Who am I**, **My human**, or **Group rules** to open an inline editor for that file

**Right - Agent team:**
- Tree visualization of all agents
- Click any node to select that agent for chat
- **✎** button on each node opens the edit modal
- **+ Agent** button (top-right) opens the create-agent dialog

**Below - Chat:**
- Full in-browser chat with the selected agent
- Agent selector dropdown + **+ Agent** button in the toolbar
- **New** starts a fresh session; **History** browses past conversations

---

### Memory page

The Memory page has **5 tiles** across the top. Click any tile to switch the view:

| Tile | Contents |
|---|---|
| **Today** 📅 | Today's conversation log (read-only). Auto-loads on open. |
| **Yesterday** 🗓 | Yesterday's conversation log (read-only). |
| **Long-term** 🧠 | `MEMORY.md` - the agent's persistent notes about you. Editable with a Save button. |
| **History** 💬 | All past chat days, newest first. Click a day to read the full log. |
| **Notes** 📝 | Custom memory files (e.g. `preferences.md`). Editable. |

---

### Skills page

Each skill shows:
- **Name + description**
- **Credential badge**: green `configured` / red `needs setup` / yellow `token in config` (move to `secrets.json`) / grey `gog auth`
- **Enable/disable toggle**
- Click a skill to expand its `SKILL.md` inline and edit the agent instructions

---

### Creating an agent (step by step)

1. Go to **Home** or **Agents**.
2. Click **+ Agent**.
3. Enter a **name** - e.g. "Research Bot". The id `research-bot` is auto-generated.
4. **Copy settings from**: defaults to the most recently used non-main agent. Copies skills and identity files.
5. Click **Create**. The agent appears in the tree on the home page.
6. Click **✎** on the new agent node to:
   - Change the title
   - Adjust which skills it has
   - Enable agent messaging and set who it can invoke
7. Go to **Agents → Identity files** to customize `WhoAmI.md` and `MyHuman.md` for this persona.

---

### GitHub skill in the dashboard

On the **Skills** page, `github` shows a credential badge:
- **configured** - token found in `secrets.json` or `GITHUB_TOKEN` env var. Ready to use.
- **needs setup** - no token found. Click the skill to expand and read the setup instructions.
- **token in config** - token found in `config.json`. Works, but move it to `secrets.json` for better security.

---

### Gmail & Calendar skills in the dashboard

`gmail` and `calendar` show a **gog auth** badge - they rely on the `gog` CLI's OAuth session. If you see errors, run `gog auth` in a terminal to re-authenticate.

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
2. Legacy date-stamped `memory/YYYY-MM-DD.md` files are **not** indexed - daily history lives in chat-log only.
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

- **Daily reset** - New session at **03:00** in `agents.defaults.userTimezone` (same timezone as reminders; `"auto"` uses the host TZ). Override hour with `agents.defaults.sessionResetHour` (0–23).
- **Manual reset** - Say e.g. `start a new session`, `new session`, or `/new-session`. Context clears and the bot replies briefly (e.g. "New session started.").
- **State file** - `~/.cowcode/chat-sessions/state.json`
- **Bootstrap (not in session history)** - On each **new session**, daemon **restart**, and every **Tide** follow-up, the model receives `MEMORY.md` plus **today and yesterday’s chat logs** (`chat-log/YYYY-MM-DD.jsonl` and, for private chats, `chat-log/private/<jid>.jsonl`). Chat session history stays scoped to the current session only.

---

## Tide (follow-up after silence)

Tide sends a single AI-composed follow-up message when a conversation goes quiet. It reads the recent conversation context and generates a short, relevant nudge ("Tests passed - what's next?" / "Still no reply on that, should I follow up?").

```json
// ~/.cowcode/config.json
{
  "tide": {
    "enabled": true,
    "silenceCooldownMinutes": 60,  // minimum silence before a follow-up is sent
    "healthCheckMinutes": 2,       // polling watchdog + follow-up scheduler interval (default 2)
    "inactiveStart": "23:00",      // quiet hours start - no Tide during this window
    "inactiveEnd": "06:00",        // quiet hours end
    "jid": ""                      // leave empty for auto-detection
  }
}
```

Tide never sends more than one follow-up per silence period, and never during the configured quiet hours. Each cycle also runs the Telegram polling watchdog (self-healing heartbeat), independent of whether a follow-up is sent.

### Tide checklist (maintenance)

Tide can run a configurable **checklist** of prompts. Each item is **one agent turn** (same skills and bootstrap context as chat)-executed **one by one** in order. Prior item results are passed as context to the next. Results are logged only (`~/.cowcode/tide-checklist-last.json`), not sent to the user.

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

**Dashboard:** **Tide** page - toggle Tide/checklist, edit triggers and items, run manually, view last results. Legacy `shell`/`http`/`builtin` config items are auto-converted to prompts on load.

---

## File and Directory Layout

### Runtime state (`~/.cowcode/`)

```
~/.cowcode/
├── config.json              # Main configuration
├── secrets.json             # Sensitive credentials (gitignored) - GitHub token, etc.
├── .env                     # API keys and env var overrides (gitignored)
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
│   ├── memory/              # Vector memory store + custom .md files
│   ├── chat-log/            # Chat history JSONL files (daily + private)
│   └── ...                  # User files
├── agents/                  # Per-agent config (id, skills, workspace/)
│   └── <agent-id>/
│       └── workspace/
│           ├── SOUL.md
│           ├── WhoAmI.md
│           └── MyHuman.md
└── groups/                  # Per-group config (agent assignment, skill deny list)
```

### Code (`~/.local/share/cowcode/` or clone root)

```
cowCode/
├── index.js                 # Entry point - connects WhatsApp + Telegram, routes messages
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
│   └── executors/           # Skill execution engines (browse, vision, github, gmail, calendar, etc.)
├── skills/
│   ├── browse/              # Playwright browser skill
│   ├── cron/                # Reminder scheduling skill
│   ├── github/              # GitHub skill (repos, issues, PRs)
│   ├── gmail/               # Gmail skill (list, read, send, archive)
│   ├── calendar/            # Google Calendar skill (events, availability)
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
- WhatsApp and Telegram connect directly - no external proxy.
- Config, auth, and chats live in `~/.cowcode` - not in the code directory.
- Local models (LM Studio, Ollama) mean zero data leaves your device.
- Cloud LLMs send only the current conversation context to the provider's API - no call history is ever sent unless it is in the active context window.
- `git push` on this repo never uploads your chats, auth files, or API keys. The `.gitignore` excludes all common state layout names.
