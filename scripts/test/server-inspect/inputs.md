# Server inspect (ssh-inspect) E2E test

Natural user messages only — see [E2E.md](../E2E.md).

| | |
|--|--|
| **Test file** | `../test-server-inspect-e2e.js` |

Requires `ssh-inspect` in `skills.enabled` and at least one registered server (`pasture server add ...`).

## Inputs

### Per registered server — project repos
- What code repositories or project folders do you see on {server-name}?

### Per registered server — log files
- What log files do you see on {server-name}?

### Multi-server (when 2+ registered)
- Check disk usage on {server1} and uptime on {server2} — tell me both.

### Unreachable host
- What log files do you see on pasture-e2e-unreachable-host?
