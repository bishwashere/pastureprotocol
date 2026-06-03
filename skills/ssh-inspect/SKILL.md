---
id: ssh-inspect
name: SSH inspect
description: Read-only inspection of a remote Linux/Unix host over SSH. Use when the user asks about disk space, folder sizes, directory layout, file contents, server health, uptime, memory, load, running processes, services, Docker containers, or anything about a named or active remote server. Requires ssh-inspect in skills.enabled and SSH key access to the host.
---

# SSH inspect

Run **read-only** commands on a remote host from the Pasture Protocol machine via `ssh`. The executor spawns the local `ssh` binary; commands execute **on the remote** and output returns here. No writes, no package installs, no interactive shell.

## How to call

`run_skill` with **skill: `"ssh-inspect"`** and structured arguments below.

## Arguments

- **host** (optional) - Registered server name (e.g. `"prod"`), IP, or dotted hostname. If omitted, the active server is used automatically.
- **command** (required) - One of the allowlisted names below.
- **argv** (required) - Array of flags and paths for that remote command only.

## Inferring the server - important

**Do not ask the user to repeat the server name on every message.** Use this priority order to determine `host`:

1. If the user mentions a server name or alias anywhere in the message (e.g. "atlas", "prod", "server1", "home assistant") → extract it and pass as `host`. Do this even when the name appears naturally, e.g. "what is the health of atlas" → `host: "atlas"`, "check atlas disk" → `host: "atlas"`.
2. If the current message has no server name but **recent conversation history** shows a server being used AND the current message is still clearly about that server or servers in general → use that same server. Pass it as `host` in the tool call.
3. If the conversation has clearly moved to a **non-server topic** (e.g. reminders, recipes, general questions, home automation, weather) - do **not** carry forward a server name from history. Treat the context as fresh; omit `host` and let the executor resolve the default.
4. If no server can be inferred from context → omit `host` entirely; the executor will auto-select the only registered server if there is one, or use the active server.
5. Only ask for clarification if truly ambiguous (e.g. multiple servers mentioned and it's unclear which applies).

**Never** respond saying the server isn't configured or ask the user to run `pasture server use` - always attempt the tool call first with the inferred host. The executor will return a clear error if the server genuinely isn't registered.

## Health checks

When the user asks about "health", "status", "how is X doing", or similar - run **multiple commands in sequence** to give a full picture:

1. `uptime` - load average and how long it's been running
2. `free` with `argv: ["-h"]` - memory usage
3. `df` with `argv: ["-h", "--total"]` - disk usage
4. `ps` with `argv: ["aux", "--sort=-%cpu"]` and `argv: ["--no-headers", "-o", "pid,comm,%cpu,%mem"]` - top processes (optional, use if relevant)

Summarise all results in one reply. Do not run them one at a time and ask the user between each.

## Allowlisted remote commands

| Category | commands |
|---|---|
| Disk & filesystem | `df`, `du`, `ls`, `find`, `lsblk`, `mount`, `findmnt` |
| File contents | `cat`, `head`, `tail`, `grep`, `wc`, `stat`, `file`, `readlink`, `realpath` |
| Processes | `ps`, `top`, `pgrep`, `pmap` |
| Network & ports | `netstat`, `ss`, `lsof`, `ifconfig`, `ip` |
| System info | `uname`, `hostname`, `whoami`, `id`, `uptime`, `free`, `dmesg`, `sysctl` |
| Performance | `vmstat`, `iostat`, `mpstat`, `sar` |
| Services & logs | `systemctl`, `journalctl`, `service` |
| Environment | `env`, `printenv`, `which`, `whereis`, `pwd` |
| Users & sessions | `last`, `lastlog`, `who`, `w` |
| Docker inspection | `docker-ps`, `docker-images`, `docker-logs`, `docker-inspect`, `docker-stats`, `docker-top`, `docker-diff`, `docker-port`, `docker-network-ls`, `docker-network-inspect`, `docker-volume-ls`, `docker-volume-inspect`, `docker-info`, `docker-version`, `docker-system-df`, `docker-image-history` |

Docker commands use a virtual name (e.g. `docker-ps`) as `command`; the executor expands it to the real `docker` invocation on the remote. `docker-stats` automatically appends `--no-stream` so it never hangs.

**Docker command → real remote call:**

| command value | runs on remote |
|---|---|
| `docker-ps` | `docker ps <argv>` |
| `docker-images` | `docker images <argv>` |
| `docker-logs` | `docker logs <argv>` |
| `docker-inspect` | `docker inspect <argv>` |
| `docker-stats` | `docker stats --no-stream <argv>` |
| `docker-top` | `docker top <argv>` |
| `docker-diff` | `docker diff <argv>` |
| `docker-port` | `docker port <argv>` |
| `docker-network-ls` | `docker network ls <argv>` |
| `docker-network-inspect` | `docker network inspect <argv>` |
| `docker-volume-ls` | `docker volume ls <argv>` |
| `docker-volume-inspect` | `docker volume inspect <argv>` |
| `docker-info` | `docker info <argv>` |
| `docker-version` | `docker version <argv>` |
| `docker-system-df` | `docker system df <argv>` |
| `docker-image-history` | `docker image history <argv>` |

**Never request:** `rm`, `dd`, `mkfs`, `kill`, `pkill`, `chmod`, `chown`, `sudo`, `bash -c`, `sh -c`, `docker exec`, `docker run`, `docker stop`, `docker rm`, `docker rmi`, `docker pull`, `docker push`, `docker build`, or any write/destructive/privilege-escalation operations.

## Examples

Disk usage (server inferred from history - no host needed):

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "command": "df", "argv": ["-h"] }`

Top folders on prod (explicit):

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "host": "prod", "command": "du", "argv": ["-xh", "--max-depth=1", "/"] }`

List all running containers on atlas:

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "host": "atlas", "command": "docker-ps", "argv": ["-a"] }`

Get logs for a container:

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "host": "atlas", "command": "docker-logs", "argv": ["--tail", "100", "my-container"] }`

Docker disk usage:

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "host": "atlas", "command": "docker-system-df", "argv": [] }`

Inspect a container:

`run_skill` with skill: `"ssh-inspect"`, arguments: `{ "host": "atlas", "command": "docker-inspect", "argv": ["my-container"] }`

## Configuration

**This skill is not enabled by default** and must be explicitly enabled - it is never active in group chats.
To enable it, either:
- Add `"ssh-inspect"` to `skills.enabled` in your dashboard (Skills tab), or
- Run `pasture skills install ssh-inspect` from the terminal, or
- Manually add `"ssh-inspect"` to `skills.enabled` in `~/.pasture/config.json` and restart.

Set up SSH key-based auth to the remote host (`ssh-copy-id` or `authorized_keys`).
Optionally set `SSH_INSPECT_USER=ubuntu` in `~/.pasture/.env` as a default remote user.
Optionally set `SSH_INSPECT_IDENTITY=/path/to/key` in `~/.pasture/.env` to use a specific private key.
Optionally set `SSH_INSPECT_TIMEOUT=30` in `~/.pasture/.env` to change the timeout in seconds.

## Server registry

Register named servers so you can say "check disk on prod" instead of typing an IP each time.
Entries are stored in `~/.pasture/config.json` under `skills["ssh-inspect"].hosts`.

**Register a server:**
```
pasture server add 203.0.113.5 prod
pasture server add 203.0.113.5 staging --user ubuntu
pasture server add 192.168.1.166 atlas --user root --alias "home assistant"
```
`host` and `name` are required. User defaults to `root`; override with `--user`. `--alias` sets a human-readable label shown alongside the server name in replies (e.g. `atlas (home assistant)`).

**Set the active server (default for all SSH commands):**
```
pasture server use prod
```
Once set, you can ask things like "check disk" or "list /var/log" without ever mentioning the server - it uses `prod` automatically.

**List registered servers:**
```
pasture server list
```

**Remove a server:**
```
pasture server remove staging
```

The executor resolves the name → hostname (and user/key) from the registry before connecting.
If the name is not in the registry, it is used directly as a hostname/IP (passthrough).

## Server label in replies

When a server has an alias, the executor prefixes every result with `[name (alias)]` - for example `[atlas (home assistant)]`. When you summarise results in your reply, naturally include this label so the user sees both the server name and the alias, e.g.: *"Atlas (Home Assistant) has 12 GB free on /"*. Do not force it into every sentence - use it where it reads naturally.

## Tool schema

```tool-schema
ssh_inspect_run
  description: Run one read-only/inspection command on a remote host via SSH. Allowed commands include df, du, ls, find, cat, head, tail, grep, ps, top, netstat, ss, lsof, ip, free, uname, uptime, systemctl, journalctl, and Docker inspection commands (docker-ps, docker-images, docker-logs, docker-inspect, docker-stats, docker-top, docker-diff, docker-port, docker-network-ls, docker-network-inspect, docker-volume-ls, docker-volume-inspect, docker-info, docker-version, docker-system-df, docker-image-history). argv contains only the flags and paths for that command. host is optional - infer from conversation history or omit to use the active server.
  parameters:
    host: string (optional)
    command: string
    argv: array
```
