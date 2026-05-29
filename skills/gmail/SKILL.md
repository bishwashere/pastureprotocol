---
id: gmail
name: Gmail
description: Gmail integration. List, read, search, send, reply, archive, trash, mark-read emails. Natural language commands like "clear my inbox" or "summarize unread". Requires gog CLI authenticated with Gmail.
---

# Gmail

Manage Gmail using semantically named actions. All operations use the `gog` CLI (which handles Google OAuth). Requires `gog` to be installed and authenticated (`gog auth`).

---

## Actions

### `list_emails`
List recent emails from inbox (or any label).
- **label** (optional) — mailbox label: `INBOX`, `SENT`, `UNREAD`, `STARRED`, `TRASH`, etc. (default: `INBOX`)
- **max** (optional) — max results, 1–200 (default: 20)
- **query** (optional) — additional Gmail search filter (e.g. `is:unread`)

### `read_email`
Read the full content of an email by its ID.
- **id** (required) — email message ID (from list_emails result)

### `search_inbox`
Search emails with a Gmail query string.
- **query** (required) — Gmail search syntax (e.g. `from:boss@corp.com newer_than:7d`, `subject:invoice`, `is:unread`)
- **max** (optional) — max results, 1–500 (default: 50)

### `send_email`
Send an email (requires user confirmation).
- **to** (required) — recipient email address (or comma-separated list)
- **subject** (required) — email subject line
- **body** (required) — email body (plain text)
- **cc** (optional) — CC addresses
- **confirm** (required) — must be `true` to actually send

### `reply_email`
Reply to an existing email thread (requires user confirmation).
- **id** (required) — original email message ID to reply to
- **body** (required) — reply text
- **confirm** (required) — must be `true` to actually send

### `archive`
Archive (remove from inbox, keep in All Mail) one or more emails.
- **ids** (required) — array of message IDs, or `"inbox"` to archive entire inbox
- **query** (optional) — Gmail search query to select which messages to archive (e.g. `older_than:30d is:read`)

### `trash`
Move emails to Trash.
- **ids** (required) — array of message IDs
- **query** (optional) — Gmail search query to select messages

### `mark_read`
Mark emails as read.
- **ids** (required) — array of message IDs, or use `query`
- **query** (optional) — Gmail search query to select messages (e.g. `is:unread in:inbox`)

### `label_email`
Add or remove a label from emails.
- **ids** (required) — array of message IDs
- **add_labels** (optional) — array of label names to add
- **remove_labels** (optional) — array of label names to remove

### `summarize_inbox`
Summarize unread or recent inbox. Returns sender breakdown, subject lines, oldest unread.
- **max** (optional) — max messages to analyze (default: 100)
- **query** (optional) — scope query (default: `is:unread in:inbox`)

---

## Natural language examples

| User says | Action |
|---|---|
| "What's in my inbox?" | `list_emails` label: INBOX |
| "Show me unread emails" | `list_emails` query: `is:unread` |
| "Search for emails from john" | `search_inbox` query: `from:john` |
| "Summarize my inbox" | `summarize_inbox` |
| "Clear my inbox" | `archive` ids: "inbox" (ask user to confirm) |
| "Send email to alice@co.com about the report" | `send_email` (compose + confirm) |
| "Archive all emails older than 30 days" | `archive` query: `older_than:30d` |
| "Mark all unread as read" | `mark_read` query: `is:unread in:inbox` |

**Behavior policy:**
- Never fabricate email content. Always answer from actual gog results.
- `send_email` and `reply_email` ALWAYS require `confirm: true`.
- For "clear my inbox" or bulk operations, show scope (how many messages will be affected) before asking for confirmation.
- Return the computed answer from data; do not refuse when data is available.

**Privacy:**
- Never save full email bodies to `MEMORY.md` or chat logs unless the user explicitly asks.
- Summarize, don't copy-paste entire threads into memory.
- When in doubt, show a brief summary and ask the user what to retain.

---

## Tool schema

```tool-schema
gmail_list_emails
  description: List recent emails from Gmail inbox or a label.
  parameters:
    label: string (optional)
    max: number (optional)
    query: string (optional)

gmail_read_email
  description: Read the full content of a Gmail message by ID.
  parameters:
    id: string

gmail_search_inbox
  description: Search Gmail with a query string (Gmail search syntax).
  parameters:
    query: string
    max: number (optional)

gmail_send_email
  description: Send a new email. Requires confirm=true.
  parameters:
    to: string
    subject: string
    body: string
    cc: string (optional)
    confirm: boolean

gmail_reply_email
  description: Reply to an email thread. Requires confirm=true.
  parameters:
    id: string
    body: string
    confirm: boolean

gmail_archive
  description: Archive emails from inbox. Use ids array or query to select messages.
  parameters:
    ids: array (optional)
    query: string (optional)

gmail_trash
  description: Move emails to Trash.
  parameters:
    ids: array (optional)
    query: string (optional)

gmail_mark_read
  description: Mark emails as read.
  parameters:
    ids: array (optional)
    query: string (optional)

gmail_summarize_inbox
  description: Summarize unread or recent inbox messages.
  parameters:
    max: number (optional)
    query: string (optional)
```
