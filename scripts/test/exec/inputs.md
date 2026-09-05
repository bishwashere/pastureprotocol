# exec

| Field | Value |
| --- | --- |
| **Test file** | `scripts/test/e2e/real/skills/test-exec-e2e.js` |
| **Path** | `--test` |
| **Primary skill** | `exec` |

## Inputs

```text
Use npx create-next-app@latest to create a Next.js app named e2e-next-exec with TypeScript, Tailwind CSS, App Router, ESLint, npm, and recommended defaults in the workspace.
```

## Expected

- The agent identifies the message as a Next.js scaffolding request.
- The agent calls `exec`, not `go-write`.
- The `exec` call invokes `npx create-next-app@latest`.
- The fake `npx` creates `workspace/e2e-next-exec/package.json`.
- On failure, the test prints chat-log lines containing `Next.js`, `create-next-app@latest`, or `e2e-next-exec`.
