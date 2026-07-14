---
id: go-write
name: Go write
description: Change the filesystem, scaffold safe project templates, and install package dependencies: create Next.js apps, copy, move, delete, create files/directories, chmod, rsync, npm install, pnpm install. Commands: create_next_app, cp, mv, rm, touch, chmod, mkdir, rsync, npm, pnpm. Enable in config (skills.enabled).
---

# Go write

Filesystem-changing commands, safe project scaffolding, and dependency installation. Enable **go-write** in configuration (`skills.enabled`) to create a Next.js app, copy, move, delete, create files and directories, change permissions, or install package dependencies.

Call `run_skill` with **skill: "go-write"**. Set **command** or **arguments.action** to the command name. Set **arguments.argv** to an array of arguments.

## Commands (allowlist)

- **cp** - Copy. argv: `["source", "dest"]` or `["-r", "source", "dest"]`. **Recursive directory copies** (e.g. a whole project folder) use `rsync` under the hood and **omit** dependency trees and common caches by default: `node_modules`, `.git`, `.cursor`, a **root-level** `verify/` folder (Cursor/local verification scratch), virtualenvs, `.next` / `dist` / `build` / `target`, IDE/build tool dirs, etc. **Do not** copy those unless the user clearly asks for a complete mirror. When they want **everything** (including `node_modules`, `.git`, caches), set **`fullCopy: true`** on the tool arguments, or put **`--pasture-full-copy`** as the **first** entry in `argv` (then the usual flags and paths follow).
- **mv** - Move/rename. argv: `["source", "dest"]`
- **rm** - Remove. argv: `["path"]` or `["-r", "path"]`
- **touch** - Create empty file or update mtime. argv: `["path"]`
- **chmod** - Change mode. argv: e.g. `["755", "file"]` or `["+x", "file"]`
- **mkdir** - Create directory. argv: `["path"]` or `["-p", "a/b/c"]`
- **npm** - Install npm dependencies. argv must start with `["install"]`, for example `["install"]` or `["install", "lodash"]`. Do not use for `npm run`, `npm test`, `npm start`, or `npm run build`; use **go-read** for those.
- **pnpm** - Install pnpm dependencies. argv must start with `["install"]`, for example `["install"]`. Do not use for `pnpm run`, `pnpm test`, `pnpm start`, or `pnpm run build`; use **go-read** for those.
- **create_next_app** - Scaffold a new Next.js app with `create-next-app@latest` using strict arguments. Use this when the user asks to create/build/scaffold a Next.js project/app/site with TypeScript, Tailwind, App Router, or recommended defaults. This is the only package generator exposed here; do not use generic `npx`, `npm create`, or `pnpm create`.
- **rsync** - **Local** directory/file tree copy with optional excludes (you can run this yourself-do not tell the user to paste a shell command unless they prefer it). argv pattern: optional short flags **only** `a`, `v`, `h`, `n` (e.g. `-a` or `-av`; `-n` = dry run), then any number of **`--exclude=PATTERN`** (must use `=`, one pattern per flag), then **exactly two** paths: **source**, **destination**. **No** remote (`user@host:` / `::`), **no** `--exclude-from`, **no** other long options. Trailing slashes on directories match normal rsync semantics (`src/` vs `src`). **When the user wants “code only, no media”**, use **rsync** with excludes-not plain `cp`. Example media-style excludes (add or drop to match their request):

  `"--exclude=*.mp4"`, `"--exclude=*.mov"`, `"--exclude=*.mkv"`, `"--exclude=*.webm"`, `"--exclude=*.wav"`, `"--exclude=*.mp3"`, `"--exclude=*.m4a"`, `"--exclude=*.png"`, `"--exclude=*.jpg"`, `"--exclude=*.jpeg"`, `"--exclude=*.gif"`, `"--exclude=*.webp"`

  Full example argv: `["-av", "--exclude=*.mp4", "--exclude=*.png", "/path/to/project/", "/path/to/dest/"]`

## Arguments

- **arguments.command** or **arguments.action** (required) - One of: cp, mv, rm, touch, chmod, mkdir, rsync, npm, pnpm
- **arguments.argv** (required) - Array of strings (flags and paths). Do not include the command name.
- **arguments.cwd** (optional) - Working directory. Defaults to workspace.
- **arguments.fullCopy** (optional) - For **`cp`** of a directory with `-r` / `-a`: if true, copy the full tree (no default excludes). Same as leading **`--pasture-full-copy`** in `argv`.

For **create_next_app**, use the dedicated `go_write_create_next_app` tool instead of `go_write_run`. Provide:

- **path** - Project directory path or project name. Relative paths are resolved from `cwd` / workspace.
- **packageManager** - `npm` or `pnpm`.
- **typescript** - `true` for TypeScript, `false` for JavaScript.
- **tailwind** - `true` to explicitly include Tailwind CSS; `false` leaves the generator default unset.
- **eslint** - `true` to explicitly include ESLint; `false` leaves the generator default unset.
- **appRouter** - `true` to explicitly use the App Router; `false` leaves the generator default unset.
- **srcDir** - `true` to explicitly use a `src/` directory; `false` leaves the generator default unset.
- **importAlias** - Import alias such as `@/*`.

## When to use

Use when the user asks to scaffold a Next.js project, copy, move, delete, or create files or directories, change permissions, or run `npm install` / `pnpm install`. For **filtered copies** (skip media, skip named globs anywhere under the tree), use **rsync** as above. Do not use for listing, disk usage, reading, `npm run`, build, test, or start-use **go-read** for those.

## Tool schema

```tool-schema
go_write_run
  description: Run a filesystem-changing command or install dependencies. command: cp, mv, rm, touch, chmod, mkdir, rsync, npm, or pnpm. npm/pnpm only allow argv starting with install. rsync is local rsync with -a/-av and --exclude=PAT only, then src dest. argv: array of args.
  parameters:
    command: string
    argv: array
    cwd: string

go_write_create_next_app
  description: Scaffold a new Next.js app with create-next-app@latest. Use for requests like "create a Next.js project/app/site" with TypeScript, Tailwind CSS, App Router, or recommended defaults. This is a narrow package-generator capability, not arbitrary npx/npm create.
  parameters:
    path: string
    packageManager: string
    typescript: boolean
    tailwind: boolean
    eslint: boolean
    appRouter: boolean
    srcDir: boolean
    importAlias: string
```
