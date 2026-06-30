# Cron skill test

Natural user messages only — see [E2E.md](../E2E.md).

| | |
|--|--|
| **Test file** | `scripts/test/e2e/skills/test-cron-e2e.js` |

## Inputs

### List
- List my reminders
- What's scheduled?
- Do I have anything scheduled?
- Do I have any reminders?
- Show my scheduled reminders

### Add
- Remind me in 2 minutes to water the plants
- Remind me to call John in 3 minutes
- Send me a hello message in 1 minute
- remind me in 5 minutes to drink water
- remind me to call mom tomorrow at 9am
- set a reminder for grocery shopping in 2 hours
- remind me every Monday to take out the trash
- create a daily reminder at 8pm to review code

### Recurring (query → expectedExpr)
- Remind me every 5 minutes to stretch → `*/5 * * * *`
- Every morning at 8am remind me to drink water → `0 8 * * *`
- Create a daily reminder at 9am for standup → `0 9 * * *`
- remind me every hour to take a break → `0 * * * *`

### Manage
- list my reminders
- show all my reminders
- what reminders do I have?
- remove reminder number 3
- delete all reminders
