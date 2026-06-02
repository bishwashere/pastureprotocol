# Projects - Dashboard Page

A visual project tracker built into the cowCode dashboard. Track work across multiple projects with chained updates and named sub-tracks (branches).

## Access

Open the dashboard (`cowcode dashboard` or `pnpm run dashboard`) and click **Projects** in the nav, or open **Projects** from Mission Control (team2).

## Database

Stored at `$COWCODE_STATE_DIR/projects.db` (default: `~/.cowcode/projects.db`) using SQLite via `better-sqlite3`.

### Schema

```sql
projects  - id, name, url (optional), description, created_at, updated_at
updates   - id, project_id, branch_id (null = main track), parent_update_id, text, created_at
branches  - id, project_id, parent_update_id (which update it branches from), name, created_at
```

## Agents (main, developer, etc.)

The Projects tracker is a **catalog** (name, URL, description) injected into the system prompt and **me** skill. When you ask "what projects do I have?", agents answer from this list.

Questions like "what is this about?" / "find out" are **not** a separate "project research" mode. They should match an **active Goal** (objectives, plan, subgoals) when the goal title/objective aligns with a tracker entry or the user's message. Agents continue that goal with tools (browse, github, memory, read, search) before asking you to pick GitHub vs local path. The dashboard **Goals** tab is where ongoing work lives; this page is for tracking updates and links.

## How to use

1. **Add a project** - type a name, optional URL, and optional description in the toolbar, click **+ Add Project**.
2. **Edit project basics** - hover the project root box and click **✎** (or **✎ Edit** below). Update name, URL, and description in the modal, then **Save**.
3. **Add an update** - click **+ Add update** at the end of any chain. Type what was done, press **⌘/Ctrl + Enter** or click **Save**.
4. **Branch off** - click **+ Branch** inside any update node. Give the branch a name (e.g. "Marketing"). A new horizontal chain appears below the main track.
5. **Edit an update** - click **✏ Edit** inside any node.
6. **Delete** - use the 🗑 buttons on updates/branches/projects. Deleting a project removes all its data.

## API

All routes are open on the local dashboard (same as other dashboard pages).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects` | Create project `{ name, url?, description? }` |
| `PATCH` | `/api/projects/:id` | Update project name, url, and/or description |
| `DELETE` | `/api/projects/:id` | Delete project + all data |
| `GET` | `/api/projects/:id/graph` | Full graph for one project |
| `POST` | `/api/projects/:id/updates` | Add update `{ text, branch_id?, parent_update_id? }` |
| `PATCH` | `/api/projects/updates/:id` | Edit update `{ text }` |
| `DELETE` | `/api/projects/updates/:id` | Delete update |
| `POST` | `/api/projects/:id/branches` | Create branch `{ name, parent_update_id? }` |
| `DELETE` | `/api/projects/branches/:id` | Delete branch + its updates |
