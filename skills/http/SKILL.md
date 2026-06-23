---
id: http
name: HTTP
description: Plain HTTP fetch (GET/POST/etc.) for JSON or text endpoints, including localhost / LAN / Pasture's own dashboard. Use this instead of browse for non-rendered URLs.
---

# HTTP

Make a plain HTTP request from the daemon process — same machine the user is on. Use this whenever the user asks you to **check a URL, hit an API, poll a JSON endpoint, or verify a service is up**, including local URLs like `http://localhost:3000/...`. No browser needed.

**Why this exists:** the `browse` skill drives a real headless Chromium via Playwright. That is correct for rendered pages (login, JS SPA, screenshots) but wrong — and brittle — for plain JSON. Cron jobs that "check an API every N seconds" should use **http**, not browse.

**Localhost works.** The daemon runs on the user's own machine. URLs like `http://localhost:3000/api/...`, `http://127.0.0.1:8080`, `http://192.168.1.x`, or `*.local` are reachable. Do not refuse to hit them.

## Commands

- **get** — Fetch a URL with GET. Set **arguments.url**. Returns `{ status, body, json?, durationMs, contentType, truncated }`. Use this for "check this API", "is the server up", "what does this endpoint return".
- **post** — POST a body. Set **arguments.url** and **arguments.body** (string or object — object will be JSON-encoded with `content-type: application/json`).
- **put** / **patch** / **delete** — Same shape as post.
- **head** — Same as get but no body returned (use to check status only).

Optional on every action:
- **arguments.headers** — object of header name → value (e.g. `{ "Authorization": "Bearer <token>" }`)
- **arguments.timeoutMs** — request timeout in ms (default 10000, capped at 60000)

## Result envelope

The result is JSON with these fields:
- `ok` — boolean (true when status is 2xx)
- `status`, `statusText`
- `url`, `method`, `durationMs`
- `contentType`
- `body` — text body, capped at 14000 chars
- `truncated` — true when the body was capped
- `json` — parsed body when `content-type` is JSON or the body parses as JSON

On failure (timeout, DNS, connection refused) the result is `{ "error": "...", "url", "method", "durationMs" }`.

## Tool schema

```tool-schema
http_get
  description: Fetch a URL with GET. Use for any plain HTTP/JSON endpoint, including http://localhost:* on this machine. Returns { status, body, json?, durationMs }.
  parameters:
    url: string
    headers: object (optional)
    timeoutMs: number (optional)

http_post
  description: POST to a URL with an optional body and headers. Body may be a string or an object (object is JSON-encoded with content-type application/json by default).
  parameters:
    url: string
    body: string (optional)
    headers: object (optional)
    timeoutMs: number (optional)

http_head
  description: HEAD request — fetch only status and headers, no body. Use to check whether a URL is reachable / a service is up.
  parameters:
    url: string
    headers: object (optional)
    timeoutMs: number (optional)
```
