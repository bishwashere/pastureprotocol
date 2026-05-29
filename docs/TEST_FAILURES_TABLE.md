# Test Suite Failure Table

**Purpose:** List each failing test, short failure reason, and whether the issue is in the **test script** or **main code** (or **Unclear**).

**No fixes applied** - classification only.

---

| Skill / Test | Failure (short) | Issue in |
|--------------|-----------------|----------|
| **Memory E2E** | "memory: chat log written" - Expected at least one line in chat-log | **Test script** |
| **Write E2E** (all 3) | Bot used go-write (touch/cp/mv), not write skill; refused to write file contents. Judge: file created but content not written / refused to write | **Main code** |
| **Edit E2E** (all 3) | Bot used go-read/go-write, not edit skill; said it can't edit file contents. Judge: did not apply edit | **Main code** |
| **Cron E2E** | "Send me a hello message in 1 minute" - Judge: didn't send hello in reply | Unclear |
| **Cron E2E** | "set a reminder for grocery shopping in 2 hours" - asked for clarification, didn't create | Unclear |
| **Cron E2E** | "create a daily reminder at 8pm" - asked for confirmation, didn't create | Unclear |
| **Browser E2E** | "What's the latest news?" - Judge: no actual latest news/headlines, asks for topics/sources | Unclear |
| **Browser E2E** | "What's the weather in London?" - Judge: no weather info, says can't access live weather | Unclear |
| **Browser E2E** | "what's the current price of Bitcoin?" - Judge: refused to give price, only limitations/source ask | Unclear |
| **Browser E2E** | "search for flights from Kathmandu to New York next week" - Judge: only links, no flight options | Unclear |
| **Browser E2E** | "go to nytimes.com and give me today's top stories" - Judge: unverified/fabricated headlines, didn't access NYT | Unclear |
| **Home-assistant E2E** | "List all my devices" - Judge: no device list; error about "devices" domain | **Main code** |

---

## Summary by category

| Category | Count | Notes |
|----------|--------|------|
| **Test script** | 1 | Memory chat-log assertion / path or timing |
| **Main code** | 7 | Write (3), Edit (3), Home-assistant (1) |
| **Unclear** | 8 | Cron (3), Browser (5+); judge strictness vs skill behavior |

*Cron and Browser counts can vary by run (flakiness).*
