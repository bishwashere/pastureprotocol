# Dashboard front-end assets

The dashboard shell is `../index.html` (small). Everything else loads from here.

## Layout

| Path | Purpose |
|------|---------|
| `css/dashboard.css` | Global dashboard styles (was inline in index.html) |
| `css/team2.css` | Mission Control (`#team2`) styles |
| `partials/nav.html` | Top navigation (Home, Memory, Crons, …) |
| `partials/modals.html` | Agent create/edit, identity editor modals |
| `partials/project-edit-modal.html` | Projects page edit modal |
| `js/00-loader.js` | Sync-loads partials + `../pages/*.html` before app scripts |
| `js/01-core-router-status.js` | Routing, status, home boot |
| `js/02-crons-skills-agents.js` | Crons, skills, agents pages |
| `js/03-chat-team.js` | Chat + classic team view |
| `js/04-mission-control.js` | Mission Control (`#team2`) |
| `js/05-bind-init.js` | Modal/chat wiring, resize observers |
| `js/06-projects.js` | Projects canvas API |
| `js/completed-tasks-display.js` | Shared task display helpers |
| `js/test-output-parse.js` | Test page output parser (ES module) |
| `../pages/*.html` | Per-page markup only |

## Edit workflow

1. Change the relevant `js/NN-*.js` or `css/*.css` file.
2. Run `` and `pnpm run test:agent-map-ui`.
3. Hard-refresh the browser after `pasture update` (bump `?v=` on CSS in `index.html` if caches are sticky).

Scripts load in numeric order; all share the same global scope as before.
