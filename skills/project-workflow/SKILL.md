---
id: project-workflow
name: Project workflow
description: Bridge conversation to dashboard Projects and Missions — list configured projects, register new ones with setup details, health-check, propose tasks, create missions after user approval, log progress, and update task status. Use when the user wants to work on, track, or manage a project.
---

# Project workflow

Connects **natural conversation** to the dashboard **Projects** tracker, **Missions** (missions/tasks), and **Tasks** views.

## When to use

Call when the user:
- asks to **work on** a project
- wants **tasks**, **progress**, or **status** tracked on the dashboard
- mentions a project that may **not be configured** yet
- says "set up a mission", "track this", "what should we do for X"
- needs a **health check** before starting (missing URL, description, setup notes, or mission)

## Workflow (follow in order)

1. **`list_projects`** — see what is already in the dashboard catalog.
2. **Catalog gate** — if the user's project is **not configured**, **stop** and ask for:
   - **name** (required)
   - **description** (required)
   - **url** (optional — repo or site)
   - **setup_notes** (optional — MongoDB URI, API URL, env vars, deployment host, etc.)
   Use **`propose_setup`** to preview, then **`apply_setup`** with **`userApproved: true`** after they confirm. **Do not** create missions until the project exists in the catalog.
3. **`health_check`** — for configured projects, verify description, URL, setup notes, progress log, and linked mission. **Ask the user** for anything important that is missing (`update_project` can save answers).
4. **`status`** — show current project + mission + task list.
5. **`propose_plan`** — preview mission title, objective, and suggested tasks (does **not** write yet). Show **tasksForDisplay** and ask for yes/no.
6. **Wait for explicit yes** — a mission alone (e.g. "increase sign ups") is **not** approval. Wait for **yes / go ahead / create it**.
7. **`apply_plan`** with **`userApproved: true`** — only after explicit yes; the tool verifies approval in the user's message.
8. During work: **`log_progress`** after meaningful steps; **`update_task`** when a task moves (todo → doing → done).

**Never** call `apply_setup` or `apply_plan` without explicit user approval.

## Actions

Pass **`action`** (or **`command`**) on every call.

| action | Purpose |
|--------|---------|
| `list_projects` | All projects in the dashboard catalog |
| `health_check` | Readiness for `project` — or `needsSetup` if not configured |
| `propose_setup` | Preview registering a **new** project (name + description required) |
| `apply_setup` | Create project in catalog — requires `userApproved: true` |
| `update_project` | Patch description, url, or setup_notes on an existing project |
| `status` | Combined project + mission + tasks snapshot |
| `propose_plan` | Preview mission + tasks for a **configured** project |
| `apply_plan` | Create/update mission — requires `userApproved: true` |
| `update_task` | Set task status (`todo`/`doing`/`done`/`blocked`) on `missionId` |
| `log_progress` | Append project update + refresh mission activity |

## Tool schema

```tool-schema
project_workflow_list_projects
  description: List all projects configured on the dashboard catalog.
  parameters: {}

project_workflow_health_check
  description: Health-check a dashboard project. Returns needsSetup if the project is not in the catalog yet, with fields to ask the user for.
  parameters:
    project: string

project_workflow_propose_setup
  description: Preview registering a new project on the dashboard. Requires name and description. Does not write until apply_setup.
  parameters:
    name: string
    description: string
    url: string
    setup_notes: string

project_workflow_apply_setup
  description: Create a new project in the dashboard catalog after user approval. Requires userApproved true.
  parameters:
    name: string
    description: string
    url: string
    setup_notes: string
    userApproved: boolean

project_workflow_update_project
  description: Update an existing project's description, url, or setup_notes after the user provides them.
  parameters:
    project: string
    description: string
    url: string
    setup_notes: string

project_workflow_status
  description: Current status for a project and/or mission — tasks, progress, health.
  parameters:
    project: string
    missionId: string

project_workflow_propose_plan
  description: Preview a mission and task list for a configured project. Does not write until user approves.
  parameters:
    project: string
    title: string
    objective: string
    tasks: array

project_workflow_apply_plan
  description: Create or update mission and tasks after user approval. Requires userApproved true.
  parameters:
    project: string
    missionId: string
    title: string
    objective: string
    tasks: array
    userApproved: boolean

project_workflow_update_task
  description: Update a mission task/task status on the dashboard.
  parameters:
    missionId: string
    taskId: string
    title: string
    status: string

project_workflow_log_progress
  description: Log progress to the project update chain and mission activity feed.
  parameters:
    project: string
    missionId: string
    text: string
```
