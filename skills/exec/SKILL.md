---
id: exec
name: Exec
description: Policy-gated command execution for package managers, project generators, build/test scripts, dev servers, and one-off CLIs. Disabled by default; add "exec" to skills.enabled to expose it. Prefer go-read/go-write for stable filesystem primitives.
---

# Exec

Run local CLI commands as a first-class command-execution capability. This skill is **disabled by default** on new installs and updates. Enable it intentionally by adding `"exec"` to `skills.enabled`.

Use **exec** for package-manager and runtime commands that are not stable filesystem primitives:

- `npx create-next-app@latest ...`
- `pnpm dlx ...`
- `npm run build`, `npm test`, `npm start`
- `pnpm run build`, `pnpm test`, `pnpm start`
- `node ...`, `git ...`, or another explicitly allowed CLI

Do not use **exec** for simple file operations that have structured tools:

- Use **go-read** for `ls`, `find`, `pwd`, `cat`, `less`, `du`, JSON, SQL, and dashboard URL resolution.
- Use **go-write** for `mkdir`, `touch`, `cp`, `mv`, `rm`, `chmod`, constrained local `rsync`, and dedicated `create_next_app` when that narrower path is enough.

## Safety model

Exec runs one executable with an argv array; it is not a free-form shell string. Put the executable in `command` and every argument in `argv`. Do not include pipes, redirections, `&&`, `;`, command substitutions, or shell scripts unless the operator has deliberately configured a shell executable in `skills.exec`.

Default runtime policy when the skill is enabled:

- `mode: "allowlist"`
- allowlist: `npm`, `pnpm`, `npx`, `node`, `git`
- macOS PATH prepend: `/opt/homebrew/bin`, `/usr/local/bin`
- Linux PATH prepend: `/usr/local/bin`
- timeout: 300 seconds

Optional config:

```json
{
  "skills": {
    "enabled": ["exec"],
    "exec": {
      "mode": "allowlist",
      "allowlist": ["npm", "pnpm", "npx", "node", "git", "cargo"],
      "pathPrepend": ["/opt/homebrew/bin", "/usr/local/bin"],
      "timeoutMs": 300000
    }
  }
}
```

Set `mode: "full"` only when the operator wants any direct executable path/name to run without the allowlist guard. Even in full mode, exec still runs without a shell unless `command` itself is a shell and the arguments invoke one.

## Verification rule

If an exec command may create, delete, or modify files, verify the result with **go-read** before claiming success. Examples:

- After `npx create-next-app@latest my-app ...`, run `go-read ls -la my-app` or inspect `my-app/package.json`.
- After `npm install`, inspect `package.json`, lockfiles, or run the requested verification script.
- After build/test commands, summarize the actual command output and exit status.

## Tool schema

```tool-schema
run
  description: Run one policy-gated executable with argv. Use for package managers, project generators, build/test scripts, dev servers, and one-off CLIs when exec is enabled. Prefer go-read/go-write for stable filesystem primitives. If the command may mutate files, verify afterward with go-read before final answering.
  parameters:
    command: string
    argv: array
    cwd: string (optional)
    timeoutMs: number (optional)
    env: object (optional)
```
