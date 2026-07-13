---
id: go-read
name: Go read
description: Read and inspect local filesystem resources. Commands: ls, find, cd, pwd, cat, less, du, npm, pnpm, json, sql, sql_schema, dashboard_url. Use for listing directories, finding files, disk usage, showing file contents, read-only npm/pnpm package inspection, structured JSON summaries, read-only SQLite queries, resolving paths and Pasture dashboard URLs. Structured reads surface primary text/label/value and measure fields before transient metadata like ids and paths. Enable in config (skills.enabled).
---

# Go read

Read-only local inspection commands. Enable **go-read** in configuration (`skills.enabled`) to list dirs, read files, and query SQLite databases without modifying them. Filesystem commands are implemented by Pasture directly; do not treat them as raw shell access.

Call `run_skill` with **skill: "go-read"**. Set **command** or **arguments.action** to the command name. Set **arguments.argv** to an array of arguments (e.g. paths, flags).

## Commands (allowlist)

- **ls** - List directory contents. argv: e.g. `["-la"]`, `["-la", "~/Downloads"]`
- **find** - Recursively find files/directories. argv: e.g. `["~/Downloads", "-maxdepth", "3", "-type", "f", "-name", "*.pdf", "-print"]`
- **cd** - Change directory and output the new path. argv: `["/path"]`. Returns the resolved path.
- **pwd** - Print working directory. argv: `[]`
- **cat** - Output file contents. argv: `["/path/to/file"]`
- **less** - View file (non-interactive). argv: `["/path/to/file"]` or with flags
- **du** - Disk usage. argv: e.g. `["-sh", "."]`, `["-d", "1", "path"]`
- **npm** - Run read-only npm inspection commands. argv must start with one of: `--version`, `-v`, `version`, `list`, `ls`, `ll`, `root`, `prefix`, `config get`, `explain`, `why`, `view`, `show`, `info`, `search`, or `outdated`. Use for npm version checks, dependency trees, package metadata, config reads, and why/explain diagnostics. Do **not** use for mutating commands such as install, add, remove, update, run, start, build, test, publish, audit fix, cache clean, or config set/delete.
- **pnpm** - Run read-only pnpm inspection commands. argv must start with one of: `--version`, `-v`, `version`, `list`, `ls`, `ll`, `root`, `prefix`, `config get`, `explain`, `why`, `view`, `show`, `info`, `search`, or `outdated`. Use for pnpm version checks, dependency trees, package metadata, config reads, and why/explain diagnostics. Do **not** use for mutating commands such as install, add, remove, update, run, start, build, test, publish, audit fix, store prune, cache clean, or config set/delete.
- **json** - Read a JSON file as structured data. Use for cache/API response JSON when the user wants items, labels, words, values, weights, counts, or ranks rather than raw file text. Arguments: **path** required (or first argv), **maxItems** optional. Returns `primaryData` arrays with text/label/name/value and measure fields before metadata.
- **sql_schema** - Inspect a SQLite database before writing SQL. Defaults to Pasture memory index `~/.pasture/memory/index.db` when no path is provided. Returns tables, columns, create SQL, and small sample rows. Arguments: **path** optional, **sampleRows** optional.
- **sql** - Run a read-only SQL query against a SQLite database. Defaults to Pasture memory index `~/.pasture/memory/index.db` when no path is provided. The executor loads available SQLite extensions such as sqlite-vec and enforces read-only/query-only mode. Arguments: **path** optional, **sql** or **query** required, **params** optional, **maxRows** or **limit** optional.
- **dashboard_url** - Resolve Pasture dashboard base URL or a route URL from process env, `~/.pasture/.env`, optional dashboard config, then source defaults. Use before probing Pasture UI routes such as `/brain`. Argument: **route** optional, e.g. `"/brain"`.

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: ls, find, cd, pwd, cat, less, du, npm, pnpm, json, sql_schema, sql, dashboard_url
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.
- **arguments.route** (optional) - For dashboard_url only, a dashboard route such as `/brain`.
- **arguments.path** (optional) - For sql_schema and sql, SQLite database path. Defaults to `~/.pasture/memory/index.db`.
- **arguments.sampleRows** (optional) - For sql_schema only, number of sample rows per ordinary table. Default 3, max 10. Use 0 for schema only.
- **arguments.maxItems** (optional) - For json only, number of items per discovered array. Default 10, max 50.
- **arguments.sql** or **arguments.query** (required for sql) - Read-only SQL statement.
- **arguments.params** (optional for sql) - SQL bind parameters as an array or object.
- **arguments.maxRows** or **arguments.limit** (optional for sql) - Maximum returned rows, capped at 1000. Default: 200.

## When to use

Use when the user asks to list a directory, find files, show disk usage (du), show file contents (cat/less), inspect a SQLite DB, count database rows, or resolve a path. Prefer **read** skill for reading with line ranges; use **go-read** for "list files", "find files", "what's in Downloads", "cat this file", "how big is this folder", "what tables are in this DB", etc.

Use **npm** or **pnpm** only for read-only package-manager inspection: versions, dependency trees, installed package locations, package metadata, config reads, and "why is this dependency installed?" questions. If the user asks to install dependencies, run a script, start a server, run tests, publish, remove packages, update lockfiles, or otherwise change project state, do not use **go-read** package-manager commands; route to the appropriate write/execution path instead.

## SQL reasoning policy

For open-ended database questions, do not guess table names, column names, virtual table behavior, or SQL shape from the user's wording. First call **sql_schema** against the target database. Use the returned schema, create SQL, and samples to decide the query. Then call **sql** with one read-only statement.

If a SQL call returns an error, treat it as repair feedback. Read the exact error, compare it to the schema result, and retry with corrected read-only SQL once or twice before telling the user it cannot be answered. Do not report "the query is erroring" unless the repaired attempts still fail. In the final answer, summarize the answer and mention the concrete error only if the user asked about the error or the answer cannot be computed.

For structured reads, treat primary values as the main data: text, label, name, title, term, word, phrase, content, weight, score, rank, count, and frequency. Treat ids, paths, line numbers, chunk ids, embeddings, vectors, source/type labels, and other provenance fields as helper metadata. Use metadata to verify where the data came from, but do not present it as the answer when the user asked for the actual items, words, labels, or values. Prefer **json** over **cat** for JSON cache/API response files because it surfaces the important arrays and fields first.

The LLM decides what information is needed and what read-only SQL to run. JavaScript only opens the database, loads needed SQLite extensions, validates read-only execution, applies row limits, and returns rows or errors.

For Pasture/CowCode self-inspection, the fixed runtime home is `~/.pasture`. When the user asks about "this project", "your code", "your source", or tells you to "check your code", list/read `~/.pasture` first. Check `~/.pasture/config.json`, `~/.pasture/workspace`, relevant logs, caches, and agent workspaces before asking the user for a path.

When the user asks how many Brain items/nodes/phrases exist, inspect schema if needed, then use read-only SQL against the default memory DB. In the final reply, provide only the count and counted thing (for example, "You have 2,875 brain nodes."). Do not mention the database path, SQL query, row count, or steps unless the user explicitly asks for those details.

When the user asks for top Brain items/words/nodes/terms, they are asking for display labels from the Brain graph, not raw memory chunks. Do not answer from `chunks` rows by id, path, line number, text length, or file frequency, and do not return raw stopword frequency. Use generic read steps instead:

1. Prefer the live dashboard data: call **dashboard_url** for `/brain`, then use the HTTP skill on `/api/brain/cloud` and extract `json.terms[].text` or `json.denseTerms[].text` in rank order.
2. If the dashboard/API is unavailable or HTTP is not in the tool set, use **find** once on the cache directory, not on guessed filenames: `command: "find"`, `argv: ["~/.pasture/brain-response-cache", "-maxdepth", "4", "-type", "f", "-name", "*.json", "-print"]`. Brain cache filenames are usually hashes, so do not search for filenames containing `brain`, `terms`, `cloud`, or `all`, and never invent a cache filename. Prefer exact paths returned by **find** under `v2`, and among candidates prefer larger files because tiny files may be failed/empty cache records. Use **ls -lh** or **du** on exact candidate paths if size is unclear. Then use **json** on exact candidate paths until you find `primaryData` for `payload.terms` or `payload.denseTerms` with non-empty `items`. Extract `payload.terms[].text` / `payload.denseTerms[].text` in rank order. Do not stop after listing only the cache directories, and do not declare the data unavailable just because one cache file has empty arrays.
3. If neither source has graph terms, say the Brain graph needs to be generated/refreshed. Do not invent a proxy list from chunks.

When the user asks about a SQLite database schema, use **sql_schema**.

When the user asks about a Pasture UI route such as `/brain`, call **dashboard_url** first with that route. Then use the returned `url` for HTTP checks. Do not guess common dev ports like 3000 before resolving the dashboard URL.

## Example

List Downloads:
`run_skill` with skill: "go-read", arguments: { command: "ls", argv: ["-la", "~/Downloads"] }

Check pnpm version:
`run_skill` with skill: "go-read", arguments: { command: "pnpm", argv: ["--version"] }

Inspect npm dependency tree:
`run_skill` with skill: "go-read", arguments: { command: "npm", argv: ["list", "--depth=0"] }

## Tool schema

```tool-schema
go_read_run
  description: Run a read-only local inspection command. Set command to ls, find, cd, pwd, cat, less, du, npm, pnpm, json, sql_schema, or sql; never set command to go_read_run. argv is for filesystem commands and read-only npm/pnpm inspection. For npm/pnpm, use only --version/-v/version/list/ls/ll/root/prefix/config get/explain/why/view/show/info/search/outdated; do not use install/add/remove/update/run/start/build/test/publish/audit fix/cache clean/config set. For json, provide path or argv[0] plus optional maxItems; it returns primaryData arrays with text/label/value and weights/ranks before metadata. For sql_schema, provide optional path/sampleRows. For sql, provide sql/query and optional path/params/maxRows. Structured rows surface primary fields before transient metadata such as ids, paths, chunks, embeddings, and vectors. For top Brain items/words/nodes/terms, do not query chunks for ids/paths/stopwords; run find on ~/.pasture/brain-response-cache with -name *.json because filenames are hashes, use exact returned paths only, prefer larger v2 files, call json on candidates until payload.terms or payload.denseTerms is non-empty, then use the text labels.
  parameters:
    command: string
    argv: array
    cwd: string
    path: string
    sampleRows: number
    maxItems: number
    sql: string
    query: string
    params: array/object
    maxRows: number
    limit: number

go_read_dashboard_url
  description: Resolve Pasture dashboard URL from process env, ~/.pasture/.env, optional dashboard config, and source defaults. Use before probing Pasture UI routes like /brain.
  parameters:
    route: string (optional)
```
