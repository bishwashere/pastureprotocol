# Evaluate team capability (`scripts/test/unit/agent/test-evaluate-team-capability.js`)

Unit tests for coordinator routing when no specialist is an obvious fit.

| | |
|--|--|
| **Test file** | `scripts/test/unit/agent/test-evaluate-team-capability.js` |
| **Run** | `pnpm run test:evaluate-team-capability` |

## Scenarios

| Scenario | User says | Expected recommendation |
|----------|-----------|-------------------------|
| Strong marketing match | What's our company tagline for marketing materials? | `delegate` → marketer |
| Unmatched domain (fitness) | I want to get in shape this summer | `create-new` or `handle-in-main`, main leads ranking, `offerUpgrade: true` |
| Explicit agent not linked | Can you check with Alex if he's around? (alex removed from allow) | `delegate` blocked |

Skill auto-enables on main when team links exist (with `agent-send`).
