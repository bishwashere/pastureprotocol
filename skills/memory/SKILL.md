---
id: memory
name: Memory
description: Semantic search over notes (MEMORY.md, memory/*.md), chat log, and filesystem index. When user ran "pasture index --source filesystem", use memory_search for "what files do I have?" with query like "directory contents". Tools: memory_search, memory_get, memory_save. See SKILL.md.
---

# Memory

Semantic search over your **notes** (`MEMORY.md`, `memory/*.md`) and optional **search log** (chat history). Use memory_search for notes whenever relevant. You can narrow by **date range** (e.g. "What did I note last week?") so results are filtered by when the note was written, not only by semantic match.

**Search log (built-in)** - Chat is stored in `workspace/chat-log/private/<chat-id>.jsonl` (one file per DM) and can be searched. **Only use memory_search to search chat history when the user explicitly asks**, e.g. "what did we talk about yesterday?", "search my logs", "last time we chatted", "what did I ask you before?", "our previous conversation". Do not search logs for general queries; only when the user clearly mentions past conversations, yesterday, or logs.

**Filesystem index** - If the user has run `pasture index --source filesystem`, the same memory index contains **directory listings** (one chunk per directory). Results can have path `filesystem/` or `filesystem/rel/path` and snippet text like "Directory: /path\nContents: file1, file2, subdir/, ...". When the user asks "what files do I have?", "list my files", "what's in my workspace?", "search my memory for files", use **memory_search** with a query that matches directory/listings, e.g. "directory contents", "list of files and folders", "files and directories". Then report the path and snippet from any results whose path starts with `filesystem/` - the snippet is the directory listing. Do not use memory_get for paths starting with `filesystem/` (only notes and chat-log paths are readable that way).

**Brain item / word questions** - When the user asks for "top brain items", "brain words", "brain nodes", "brain terms", or asks to "give the word", they want the final display labels from the Brain graph, not memory chunks. Do not answer with chat-log paths, source files, internal IDs, chunk lengths, row counts, or raw stopword frequency (`the`, `and`, `you`, etc.). If Brain graph data is available from a tool/API result, list only `terms[].text` / `denseTerms[].text` labels in rank order. If only chunk rows or file paths are available, say you need the Brain graph terms rather than inventing proxies.

**Auto-indexing** - Notes (MEMORY.md, memory/*.md) and chat-log files are synced when you run memory_search. No manual "moo index" needed.

## Tools (pass `tool` in arguments: "memory_search", "memory_get", or "memory_save")

- **memory_search** - Set `tool: "memory_search"`, `query` (required). Optional: `maxResults`, `minScore`, `date`, **`dateFrom`**, **`dateTo`**, **`dateRange`**, **`type`**. Searches notes (and chat when the user asks about past conversations). **Date range** - When the user asks for notes or activity in a time window (e.g. "What did I note last week?", "notes from February", "yesterday's notes"), set **`dateFrom`** and **`dateTo`** as `YYYY-MM-DD`, or use **`dateRange`**: `"yesterday"`, `"last_week"` / `"last_7_days"`, or `"last_month"`. Results are restricted to chunks whose date falls in that range (not only semantic match). For "yesterday" chat, `date: "yesterday"` still includes that day's chat-log; combining with `dateRange: "yesterday"` narrows both notes and chat to that day. **Type filter** - Set `type` to restrict results to a specific category (e.g. `"chat"`, `"filesystem"`, or any custom type used when saving). Returns snippets with path, line range, and `type` field (paths may be `MEMORY.md`, `memory/2025-02-15.md`, `chat-log/2025-02-16.jsonl`, or `filesystem/` / `filesystem/rel/path` for directory listings). Only search chat when the user explicitly mentions it.
- **memory_get** - Set `tool: "memory_get"`, `path` (required, from memory_search). Optional: `from`, `lines`. Read a snippet by path (including chat-log/*.jsonl when the user explicitly asked about past conversations).
- **memory_save** - Set `tool: "memory_save"`, `text` (required): the note to save. Optional: `file` (default: `MEMORY.md`; use `memory/notes.md` or any `.md` path inside the workspace), `type` (a short category label, e.g. `"preference"`, `"project"`, `"task"`). Appends the note with today's date (and type tag if given) and immediately re-indexes so it is searchable at once. Use when the user says "remember that…", "note this down", "save this for later", "add to my notes", etc.

## Tool schema

```tool-schema
memory_search
  description: Semantic search over notes (MEMORY.md, memory/*.md), chat log, and filesystem index.
  parameters:
    query: string
    dateFrom: string
    dateTo: string
    dateRange: string
    type: string
    maxResults: number
    minScore: number

memory_get
  description: Read a file/snippet by path (from memory_search result). Use for notes and chat-log paths.
  parameters:
    path: string
    from: number
    lines: number

memory_save
  description: Append a note to MEMORY.md or another .md file. Use for "remember that", "note this down".
  parameters:
    text: string
    file: string
    type: string
```

## Config

- Add `"memory"` to `skills.enabled`. Embedding: if an OpenAI key is available (e.g. `OPENAI_API_KEY` or an OpenAI model in LLM config), OpenAI is used; otherwise local (Ollama, `nomic-embed-text`) is used. You can override with `memory.embedding` in config.
- Workspace: `~/.pasture/workspace/`. Create `MEMORY.md` and optionally `memory/*.md`. Chat logs live in `workspace/chat-log/` and are created automatically.
