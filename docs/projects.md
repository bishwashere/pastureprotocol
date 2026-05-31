# Projects - Dashboard Page

A visual project tracker built into the cowCode dashboard. Track work across multiple projects with chained updates and named sub-tracks (branches).

## Access

Open the dashboard (`cowcode dashboard` or `pnpm run dashboard`) and click **Projects** in the nav.

You'll be prompted to sign in.

## Auth - default credentials

| Field | Default | Override |
|-------|---------|----------|
| Username | `admin` | `COWCODE_PROJECTS_USERNAME` env var, or `config.json → dashboard.projects.username` |
| Password | `cowcode` | `COWCODE_PROJECTS_PASSWORD` env var, or `config.json → dashboard.projects.password` |

To change credentials, add to `~/.cowcode/.env`:
```
COWCODE_PROJECTS_USERNAME=yourname
COWCODE_PROJECTS_PASSWORD=yourpassword
```

Or in `~/.cowcode/config.json`:
```json
{
  "dashboard": {
    "projects": {
      "username": "yourname",
      "password": "yourpassword"
    }
  }
}
```

Sessions last 24 hours and are stored in the browser's `sessionStorage` (cleared on tab close).

## Database

Stored at `$COWCODE_STATE_DIR/projects.db` (default: `~/.cowcode/projects.db`) using SQLite via `better-sqlite3`.

### Schema

```sql
projects  - id, name, url (optional), description, created_at, updated_at
updates   - id, project_id, branch_id (null = main track), parent_update_id, text, created_at
branches  - id, project_id, parent_update_id (which update it branches from), name, created_at
```

## Agents (main, developer, etc.)

Projects in this tracker are injected into the **system prompt** on every private chat turn and included in the **me** skill profile. When you ask "what projects do I have?", agents should answer from this list—not claim they don't know if projects exist here.

Follow-ups like "what is this project about?" / "find out" resolve to the tracked project (especially when only one exists). Agents are instructed to **browse the project URL** (or search/memory) and must not ask you to pick GitHub vs local path vs tracker. Delegated agents receive the same context in their message.

## How to use

1. **Add a project** - type a name, optional URL, and optional description in the toolbar, click **+ Add Project**.
2. **Edit project basics** - hover the project root box and click **✎** (or **✎ Edit** below). Update name, URL, and description in the modal, then **Save**.
3. **Add an update** - click **+ Add update** at the end of any chain. Type what was done, press **⌘/Ctrl + Enter** or click **Save**.
4. **Branch off** - click **+ Branch** inside any update node. Give the branch a name (e.g. "Marketing"). A new horizontal chain appears below the main track.
5. **Edit an update** - click **✏ Edit** inside any node.
6. **Delete** - use the 🗑 buttons on updates/branches/projects. Deleting a project removes all its data.

## API

All routes require the `x-projects-token` header (obtained from `POST /api/projects/auth`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/projects/auth` | Login → returns `{ token }` |
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
