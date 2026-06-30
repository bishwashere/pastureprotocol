# Casual greeting tests

Fast **unit** checks (no LLM) plus optional **E2E** via `index.js --test`.

| | |
|--|--|
| **Test file** | `scripts/test/e2e/agent/test-casual-greetings.js` |
| **Run** | `pnpm run test:casual-greetings` |

## Unit inputs (`isNonTaskMessage` = true)

- hi
- hello
- hey
- hey!
- thanks
- thank you
- ok
- Hi there
- good morning

## Unit inputs (must stay task messages)

- what is hi
- find out about nextpostai
- fix the nginx 502 error

## E2E inputs (no tools, conversational reply)

- hi
- hello
- hey!
