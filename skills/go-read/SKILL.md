---
id: go-read
name: Go read
description: Read and inspect local filesystem resources. Commands: ls, cd, pwd, cat, less, du, sql, sql_schema, dashboard_url. Use for listing directories, disk usage, showing file contents, read-only SQLite queries, resolving paths and Pasture dashboard URLs. Enable in config (skills.enabled).
---

# Go read

Read-only local inspection commands. Enable **go-read** in configuration (`skills.enabled`) to list dirs, read files, and query SQLite databases without modifying them.

Call `run_skill` with **skill: "go-read"**. Set **command** or **arguments.action** to the command name. Set **arguments.argv** to an array of arguments (e.g. paths, flags).

## Commands (allowlist)

- **ls** - List directory contents. argv: e.g. `["-la"]`, `["-la", "~/Downloads"]`
- **cd** - Change directory and output the new path. argv: `["/path"]`. Returns the resolved path.
- **pwd** - Print working directory. argv: `[]`
- **cat** - Output file contents. argv: `["/path/to/file"]`
- **less** - View file (non-interactive). argv: `["/path/to/file"]` or with flags
- **du** - Disk usage. argv: e.g. `["-sh", "."]`, `["-d", "1", "path"]`
- **sql_schema** - Inspect a SQLite database before writing SQL. Defaults to Pasture memory index `~/.pasture/memory/index.db` when no path is provided. Returns tables, columns, create SQL, and small sample rows. Arguments: **path** optional, **sampleRows** optional.
- **sql** - Run a read-only SQL query against a SQLite database. Defaults to Pasture memory index `~/.pasture/memory/index.db` when no path is provided. The executor loads available SQLite extensions such as sqlite-vec and enforces read-only/query-only mode. Arguments: **path** optional, **sql** or **query** required, **params** optional, **maxRows** or **limit** optional.
- **dashboard_url** - Resolve Pasture dashboard base URL or a route URL from process env, `~/.pasture/.env`, optional dashboard config, then source defaults. Use before probing Pasture UI routes such as `/brain`. Argument: **route** optional, e.g. `"/brain"`.

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: ls, cd, pwd, cat, less, du, sql_schema, sql, dashboard_url
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.
- **arguments.route** (optional) - For dashboard_url only, a dashboard route such as `/brain`.
- **arguments.path** (optional) - For sql_schema and sql, SQLite database path. Defaults to `~/.pasture/memory/index.db`.
- **arguments.sampleRows** (optional) - For sql_schema only, number of sample rows per ordinary table. Default 3, max 10. Use 0 for schema only.
- **arguments.sql** or **arguments.query** (required for sql) - Read-only SQL statement.
- **arguments.params** (optional for sql) - SQL bind parameters as an array or object.
- **arguments.maxRows** or **arguments.limit** (optional for sql) - Maximum returned rows, capped at 1000. Default: 200.

## When to use

Use when the user asks to list a directory, show disk usage (du), show file contents (cat/less), inspect a SQLite DB, count database rows, or resolve a path. Prefer **read** skill for reading with line ranges; use **go-read** for "list files", "what's in Downloads", "cat this file", "how big is this folder", "what tables are in this DB", etc.

## SQL reasoning policy

For open-ended database questions, do not guess table names, column names, virtual table behavior, or SQL shape from the user's wording. First call **sql_schema** against the target database. Use the returned schema, create SQL, and samples to decide the query. Then call **sql** with one read-only statement.

If a SQL call returns an error, treat it as repair feedback. Read the exact error, compare it to the schema result, and retry with corrected read-only SQL once or twice before telling the user it cannot be answered. Do not report "the query is erroring" unless the repaired attempts still fail. In the final answer, summarize the answer and mention the concrete error only if the user asked about the error or the answer cannot be computed.

The LLM decides what information is needed and what read-only SQL to run. JavaScript only opens the database, loads needed SQLite extensions, validates read-only execution, applies row limits, and returns rows or errors.

For Pasture/CowCode self-inspection, the fixed runtime home is `~/.pasture`. When the user asks about "this project", "your code", "your source", or tells you to "check your code", list/read `~/.pasture` first. Check `~/.pasture/config.json`, `~/.pasture/workspace`, relevant logs, caches, and agent workspaces before asking the user for a path.

When the user asks how many Brain items/nodes/phrases exist, inspect schema if needed, then use read-only SQL against the default memory DB. In the final reply, provide only the count and counted thing (for example, "You have 2,875 brain nodes."). Do not mention the database path, SQL query, row count, or steps unless the user explicitly asks for those details.

When the user asks for top Brain items/words/nodes/terms, they are asking for display labels from the Brain graph, not raw memory chunks. Do not answer from `chunks` rows by id, path, line number, text length, or file frequency, and do not return raw stopword frequency. Resolve the Brain dashboard URL if needed and inspect the Brain graph/API/cache shape; when graph data is available, extract `terms[].text` or `denseTerms[].text` in rank order. If only chunk rows are available, say the graph terms are needed instead of inventing a proxy list.

When the user asks about a SQLite database schema, use **sql_schema**.

When the user asks about a Pasture UI route such as `/brain`, call **dashboard_url** first with that route. Then use the returned `url` for HTTP checks. Do not guess common dev ports like 3000 before resolving the dashboard URL.

## Example

List Downloads:
`run_skill` with skill: "go-read", arguments: { command: "ls", argv: ["-la", "~/Downloads"] }

## Tool schema

```tool-schema
go_read_run
  description: Run a read-only local inspection command. command: ls, cd, pwd, cat, less, du, sql_schema, or sql. argv: array of args for filesystem commands. For sql_schema, provide optional path/sampleRows. For sql, provide sql/query and optional path/params/maxRows.
  parameters:
    command: string
    argv: array
    cwd: string
    path: string
    sampleRows: number
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
