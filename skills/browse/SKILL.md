---
id: browse
name: Browse
description: Local browser control: navigate, click, scroll, fill forms, screenshot. Uses Playwright (Chromium). See SKILL.md for arguments.
---

# Browse

Control a **local headless browser** (Playwright/Chromium) on the user's machine. No cloud middleman. Use when the user wants to **go to a URL, interact with the page, or bring back proof** (e.g. open a site, click a button, fill a form, take a screenshot).

**Persistent tab:** The browser keeps the **same tab open per chat** across messages (same Playwright page object is reused when possible). So you can navigate to a site (e.g. slickdeals.net), get top deals, then on the user's next message ("show me tech ones" or "what about in tech department") **stay on that page** - click the category link or navigate and extract. The tool result includes "Current page: &lt;url&gt; (tab kept open for follow-up)" so you know which URL to pass for the next action.

**Follow-up on category:** When the user asks for a specific category (e.g. "what about tech", "show me electronics"), either (1) **navigate** to the category path if you know it - e.g. `https://slickdeals.net/deals/tech` or `/deals/tech` relative to the current origin - then extract the list, or (2) **click** the category link using a selector. Categories are often in a `<nav>` or sidebar; see **Category selectors** below for patterns that work across many sites.

Call **run_skill** with **skill: "browse"**. Set **command** or **arguments.action** to one of: **navigate**, **click**, **scroll**, **fill**, **screenshot**, **reset**.

## Commands

- **reset** - Force-close the current browser tab and clear the session so the next browse starts fresh (e.g. after login/logout, or when the user says "reset the browser" or uses the **/browse-reset** command). No **arguments.url** needed.
- **navigate** - Open a URL and return the page's text content. Set **arguments.url** (full http/https URL). Tab stays open for follow-ups.
- **click** - Go to **arguments.url** (or reuse current tab if already there), click an element, return the new page content. Set **arguments.selector** (CSS selector, e.g. `a[href*="tech"]`, `button.submit`, `[aria-label="Submit"]`). Use the "Current page" URL from the previous result when the user asks a follow-up on the same site.
- **scroll** - On **arguments.url** (or current tab), scroll the page. Set **arguments.direction** to one of: **down**, **up**, **top**, **bottom** (default: down).
- **fill** - On **arguments.url** (or current tab), fill a form field. Set **arguments.selector** and **arguments.value**.
- **screenshot** - On **arguments.url** (or current tab), capture a screenshot. Optional **arguments.selector**. Saved under `~/.pasture/browse-screenshots/`. After capture, the tool auto-runs vision to describe the screenshot and suggest a next action (e.g. scroll, click category); use that hint for follow-up if helpful.

## Category selectors (deal/category sites)

Category links are often in a **nav** or **sidebar**. Try these selector patterns when the user asks for a specific category (e.g. tech, electronics, home):

| Pattern | Example selector | Use when |
|--------|-------------------|----------|
| **href path** | `a[href*="/deals/tech"]`, `a[href*="/category/electronics"]` | URL path contains the category (e.g. `/deals/tech/`, `/deals/electronics`) |
| **nav links** | `nav a[href*="tech"]`, `nav a[href*="deals"]` | Categories live inside `<nav>` |
| **Sidebar / category nav classes** | `.sdcatnav a`, `.category-link`, `.sidebar a`, `[class*="category"] a`, `[class*="catnav"] a` | Site uses classes like `sdcatnav`, `category-link`, or "category"/"catnav" in class names |
| **Link text** | `a:has-text("Tech")`, `a:has-text("Electronics")` | Playwright supports `:has-text()`; use when the visible text is the category name |
| **Data attributes** | `a[data-category="tech"]`, `[data-category]` | Site uses data attributes for categories |

For **click**, prefer: (1) href pattern `a[href*="/deals/tech"]` if the site uses `/deals/{category}`; (2) nav + href `nav a[href*="tech"]`; (3) class-based `.sdcatnav a`, `.category-link`; (4) link text if you need to match visible label. If the first selector fails (element not found), try another from the list or inspect the page content from a previous **navigate** result.

## When to use Browse vs Search

- **Search** (skill "search"): find info - queries, news, weather, "what's out there". Text in, text out.
- **Browse** (skill "browse"): interact with the web - "open this URL", "click the category", "show me tech deals". Same tab across messages for natural drill-down.

Always pass **arguments.url** for navigate, click, scroll, fill, screenshot (use the "Current page" URL from the last browse result when doing follow-up actions on the same site). **reset** needs no url. Always use a valid CSS selector for **click** and **fill**. Optional: the user can type **/browse-reset** to force a clean slate without going through the agent.

## Tool schema

```tool-schema
browse_reset
  description: Close the browser tab and clear the session. No parameters.

browse_navigate
  description: Open a URL and return page text content.
  parameters:
    url: string

browse_click
  description: Click an element on the page. Use selector (e.g. CSS) and optional url for current tab.
  parameters:
    url: string
    selector: string

browse_scroll
  description: Scroll the page. Optional direction (down, up, top, bottom).
  parameters:
    url: string
    direction: string

browse_fill
  description: Fill a form field. Set selector and value.
  parameters:
    url: string
    selector: string
    value: string

browse_screenshot
  description: Capture a screenshot. Optional selector. Saved under ~/.pasture/browse-screenshots/.
  parameters:
    url: string
    selector: string
```
