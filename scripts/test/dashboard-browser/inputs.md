# Dashboard browser E2E

Playwright checks against a **temporary** dashboard server started from this repo (`dashboard/public` assets).

| Case | Action | Expected |
|------|--------|----------|
| home-status-loads | Open `#home` | `#chat-status-text` leaves "Checking…" |
| chat-plus-agent-opens-modal | Click `#chat-agent-create-btn` | `#agent-create-modal` has class `open` |
| team-plus-agent-opens-modal | Click `#agent-team-create-btn` | Create agent modal opens |
| chat-new-focuses-input | Click `#chat-new-btn` | `#chat-input` receives focus |
| chat-send-click-no-throw | Click `#chat-send` (empty input) | No page script error |

Run: `pnpm run test:dashboard-browser-e2e`

Requires Playwright Chromium (`npx playwright install chromium` on first run).
