---
id: calendar
name: Calendar
description: Google Calendar integration. List events, create events, check availability, delete events. Natural language commands like "book 30 min with John next Tuesday" or "what's on my calendar this week". Requires gog CLI authenticated with Google Calendar.
---

# Calendar

Manage Google Calendar using semantically named actions. All operations use the `gog` CLI (which handles Google OAuth). Requires `gog` to be installed and authenticated (`gog auth`).

---

## Actions

### `list_events`
List upcoming calendar events.
- **days** (optional) - how many days ahead to look (default: 7)
- **max** (optional) - max results (default: 20)
- **calendar** (optional) - calendar ID or name (default: primary)
- **query** (optional) - text search filter within events

### `get_event`
Get full details of a specific event.
- **event_id** (required) - event ID (from list_events result)
- **calendar** (optional) - calendar ID (default: primary)

### `create_event`
Create a new calendar event (requires user confirmation).
- **title** (required) - event title/summary
- **start** (required) - start datetime in ISO 8601 or natural language (e.g. "next Tuesday 2pm", "2026-06-05T14:00:00")
- **end** (optional) - end datetime or duration (e.g. "30min", "1h", ISO 8601). Default: 1 hour after start.
- **description** (optional) - event description/notes
- **attendees** (optional) - comma-separated email addresses to invite
- **location** (optional) - event location (physical address or video link)
- **calendar** (optional) - calendar ID (default: primary)
- **confirm** (required) - must be `true` to actually create

### `update_event`
Update an existing calendar event (requires user confirmation).
- **event_id** (required) - event ID to update
- **title** (optional) - new title
- **start** (optional) - new start time
- **end** (optional) - new end time or duration
- **description** (optional) - new description
- **location** (optional) - new location
- **calendar** (optional) - calendar ID (default: primary)
- **confirm** (required) - must be `true` to actually update

### `delete_event`
Delete a calendar event (requires user confirmation).
- **event_id** (required) - event ID to delete
- **calendar** (optional) - calendar ID (default: primary)
- **confirm** (required) - must be `true` to actually delete

### `check_availability`
Check free/busy time for the authenticated user (and optionally other attendees).
- **start** (required) - start of period to check (ISO 8601 or natural language)
- **end** (required) - end of period to check
- **attendees** (optional) - comma-separated email addresses to also check
- **calendar** (optional) - calendar ID (default: primary)

### `find_free_slot`
Find the next available time slot of a given duration within a time range.
- **duration** (required) - slot duration (e.g. `"30min"`, `"1h"`, `"90min"`)
- **from** (optional) - search start (default: now)
- **until** (optional) - search end (default: +7 days)
- **business_hours_only** (optional) - if true, only look within 9am–6pm Mon–Fri (default: true)

---

## Natural language examples

| User says | Action |
|---|---|
| "What's on my calendar this week?" | `list_events` days: 7 |
| "Do I have anything tomorrow?" | `list_events` days: 2 |
| "Book a 30 min meeting with john@co.com next Tuesday at 2pm" | `create_event` (parse time, set attendees) |
| "Create a 1-hour team sync every Monday at 10am" | `create_event` (recurring - use gog recurrence) |
| "Am I free next Friday at 3pm?" | `check_availability` (specific slot) |
| "Find a free 1-hour slot this week" | `find_free_slot` duration: 1h |
| "Delete the standup tomorrow" | find event → `delete_event` (with confirm) |
| "Move the 3pm meeting to 4pm" | find event → `update_event` (with confirm) |

**Behavior policy:**
- `create_event`, `update_event`, and `delete_event` ALWAYS require `confirm: true`.
- For natural language times (e.g. "next Tuesday 2pm"), convert to ISO 8601 before calling. Use the user's local timezone (from system or prior context).
- For "all day" events, use the all-day date format (e.g. start: "2026-06-05", end: "2026-06-06").
- Never fabricate event data or claim to have created/deleted something without calling the tool.
- Return the computed answer from data; do not refuse when data is available.
- Before `create_event`, always show what will be created (title, time, attendees) and ask for confirmation.

**Privacy:**
- Never save event attendee emails or meeting notes to `MEMORY.md` without explicit user request.
- Summarize calendar data rather than storing raw API responses in memory.

---

## Tool schema

```tool-schema
calendar_list_events
  description: List upcoming Google Calendar events.
  parameters:
    days: number (optional)
    max: number (optional)
    calendar: string (optional)
    query: string (optional)

calendar_get_event
  description: Get full details of a calendar event by ID.
  parameters:
    event_id: string
    calendar: string (optional)

calendar_create_event
  description: Create a new Google Calendar event. Requires confirm=true.
  parameters:
    title: string
    start: string
    end: string (optional)
    description: string (optional)
    attendees: string (optional)
    location: string (optional)
    calendar: string (optional)
    confirm: boolean

calendar_update_event
  description: Update an existing Google Calendar event. Requires confirm=true.
  parameters:
    event_id: string
    title: string (optional)
    start: string (optional)
    end: string (optional)
    description: string (optional)
    location: string (optional)
    calendar: string (optional)
    confirm: boolean

calendar_delete_event
  description: Delete a Google Calendar event. Requires confirm=true.
  parameters:
    event_id: string
    calendar: string (optional)
    confirm: boolean

calendar_check_availability
  description: Check free/busy availability for a time range.
  parameters:
    start: string
    end: string
    attendees: string (optional)
    calendar: string (optional)

calendar_find_free_slot
  description: Find the next available time slot of a given duration.
  parameters:
    duration: string
    from: string (optional)
    until: string (optional)
    business_hours_only: boolean (optional)
```
