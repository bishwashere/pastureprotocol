---
id: search
name: Search
description: Search the web or fetch a URL. Actions: search (query), navigate (url). See skill.md for arguments.
---

# Search

Search the web or fetch a page. Call **run_skill** with **skill: "search"**. The **command name** is the operation: use **command** or **arguments.action** set to exactly one of: **search**, **navigate**.

## Commands (name is command)

- **search** - For current time, weather, date, latest news, or any live query. Set **arguments.query** (e.g. "current time", "weather in Tokyo", "latest news"). Use a clear, concrete query.
- **navigate** - When the user gives a specific URL to read. Set **arguments.url** (full http or https URL).

You can pass the command at the top level (`command: "search"`) or inside arguments (`arguments.action: "search"`). Never omit the command/action.

## Tool schema

```tool-schema
search_search
  description: Search the web. ALWAYS use this for any question about current events, recent news, election results, sports scores, prices, people, places, or anything that may have changed. Do not answer from memory when this tool is available.
  parameters:
    query: string

search_navigate
  description: Open a URL and return page content.
  parameters:
    url: string
```

## Config

- Brave Search: set `BRAVE_API_KEY` in .env or `skills.search.apiKey` in config.json (or `skills.browser.search.apiKey` for backward compatibility).
- Without Brave: news queries use RSS; other queries fall back to Playwright + DuckDuckGo Lite.
