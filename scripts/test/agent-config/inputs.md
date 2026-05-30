# Agent config contract test

Natural user messages N/A — config/on-disk checks only. See [agent-team/inputs.md](../agent-team/inputs.md) for E2E chat scenarios.

| | |
|--|--|
| **Test file** | `../test-agent-config.js` |

## Inputs

### Contract checks (no user chat)
- Team links enable agent-send on main
- Rename marketer → Chloe keeps id + title aliases
- Stale allow list `[chloe, ghost]` repairs to `marketer` and drops unknown ids
