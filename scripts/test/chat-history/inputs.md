# Chat history depth test

| | |
|--|--|
| **Test file** | `scripts/test/unit/core/test-chat-history.js` |

## Inputs

| Scenario | Input |
|----------|-------|
| Default cap | `DEFAULT_CHAT_HISTORY_EXCHANGES === 20` |
| Resolve helper | `undefined` → 20, `8` → 8, `0` → 20 |
| Read cap | 25 logged exchanges → last 20 pairs returned |
