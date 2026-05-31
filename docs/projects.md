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

## How to use

1. **Add a project** - type a name, optional URL, and optional description in the toolbar, click **+ Add Project**.
2. **Add an update** - click **+ Add update** at the end of any chain. Type what was done, press **⌘/Ctrl + Enter** or click **Save**.
3. **Branch off** - click **+ Branch** inside any update node. Give the branch a name (e.g. "Marketing"). A new horizontal chain appears below the main track.
4. **Edit an update** - click **✏ Edit** inside any node.
5. **Delete** - use the 🗑 buttons on updates/branches/projects. Deleting a project removes all its data.

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
