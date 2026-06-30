# Project workflow E2E (`scripts/test/e2e/core/test-project-workflow-e2e.js`)

Multi-turn conversational tests. Every user message must read like a real user.
No tool names, no function names, no pre-written steps for the agent to parrot back.

## Why this file exists separately from `scripts/test/unit/core/test-project-workflow.js`

`scripts/test/unit/core/test-project-workflow.js` calls library functions directly — it is a unit/contract test for
the project-workflow data layer. This file tests the **full user path** through `index.js --test`,
where the agent must decide on its own what to do next.

## Setup rule

`seedProjectOnly()` may write a project catalog entry (name, description, URL) to stateDir before
the first message. That is the only setup allowed — equivalent to agent fixture setup in
`scripts/test/e2e/agent/test-agent-team-e2e.js`. No mission, no tasks, no plan steps are pre-seeded.

## Multi-turn approach

Each turn runs `runE2E(message, { stateDir })` sequentially. Chat history is persisted to disk
between turns and loaded by the next `--test` invocation, exactly as in real usage.

## Scenarios

| Scenario | User says (first turn) | Turns |
|----------|------------------------|-------|
| Known project status | What's the status of NextPostAI and what should we focus on next? | 1 |
| New project cold intro | I've been building a SaaS called TideApp that helps small teams track their weekly sprints. I want to start growing it. | 1 |
| New project two-turn setup | (1) I want to grow a product called TideApp — it's a sprint tracking tool for small engineering teams. The URL is tideapp.io. → (2) Yes, go ahead and set it up. Let's create a plan. | 2 |
| Plan proposal — no false completion | Can you put together a growth plan for NextPostAI and start working on it? | 1 |
| Three-turn full workflow | (1) We have a product called PastureDemo… → (2) Yes, go ahead and create the mission and the tasks. → (3) What are we working on for PastureDemo right now? | 3 |
| Project exists, no mission | Let's start working on NextPostAI. Where should we begin? | 1 |
| No context — agent asks questions | I want to get more customers. What's the plan? | 1 |

## What a PASS looks like

- Bot references the project by name or asks about it.
- Bot proposes or describes at least one concrete task, area, or next step.
- Bot does NOT claim all tasks are completed in the same reply they were created.
- Bot follows conversation state on turn 3+ (not starting fresh).
- Bot asks clarifying questions when there is no project context.

## What a FAIL looks like

- "Sorry, I can't help with that."
- Generic "sounds great, let me know what you want to do" with no direction.
- Fabricating a detailed plan for an unknown business without any clarification.
- Listing all tasks as "completed ✅" in the same response that created them.
- Completely ignoring prior conversation context on turn 3.
