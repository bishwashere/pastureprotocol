# Cron dry-run trace

| | |
|--|--|
| **Test file** | `../test-dry-run.js` → `dry-run-reminder.js` |

## Inputs

| Scenario | Message |
|----------|---------|
| Clear reminder add | Remind me to call Bishwas tomorrow at 5.30 p.m. |
| Invalid schedule (blue moon) | Remind me next week on the blue moon |

Optional: pass `--live` as CLI arg to call the real LLM (not used from dashboard).
