# Tide skill test

| | |
|--|--|
| **Test file** | `scripts/test/unit/agent/test-tide.js` |

## Inputs

Payload (JSON to stdin of `cron/run-tide.js`):

- **jid**: `7656021862`
- **storePath**: temp `cron/jobs.json`
- **workspaceDir**: temp workspace
- **historyMessages**:
  - user: `Remind me in 5 minutes to test`
  - assistant: `Done. I'll remind you in 5 minutes.`
