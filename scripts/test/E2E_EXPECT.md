# E2E expect modes

Each skill E2E test case can set **`expectMode`**:

| Mode | Meaning | Pass when |
|------|---------|-----------|
| **`behavior`** (default) | Skill routing / handling | LLM judge says YES |
| **`actual`** | Real outcome required | Judge YES **and** skill was called **and** reply is not failure-only **and** optional `actualChecks` |

Set on the test object in each `test-*-e2e.js` file:

```js
{
  name: 'search: UTC time',
  expectMode: 'actual',
  skill: 'search',
  run: async () => { ... return { reply, skillsCalled, stateDir }; },
}
```

Optional **`actualChecks`** (only for `actual`):

- `replyIncludesAny: ['Test User']` — reply must contain at least one string
- `fileExists: 'workspace/e2e-hello.txt'`
- `fileContains: { path: 'workspace/foo.txt', text: 'expected' }`

Implementation: `e2e-expect.js` + `skill-test-runner.js` (runs checks after `run()` succeeds).

---

## Per-skill evaluation

Not every scenario needs `actual`. Use **`actual`** for one representative “must get data” case per skill; keep the rest **`behavior`** so routing / error handling still gets coverage.

| Skill | Test file | `actual` scenarios | `behavior` scenarios |
|-------|-----------|-------------------|----------------------|
| **home-assistant** | `test-home-assistant-e2e.js` | `list my lights` | other list/device queries |
| **browser** | `test-browser-e2e.js` | 1× news, 1× non-news, 1× browser-specific | remaining headline/search queries |
| **search** | `test-search-e2e.js` | all (web fetch required) | — |
| **gog** | `test-gog-e2e.js` | calendar + Gmail list | — |
| **ssh-inspect** | `test-server-inspect-e2e.js` | per-server repo + log queries (real SSH output) | unreachable host → clear error OK |
| **memory** | `test-memory-e2e.js` | recall + filesystem index (also has code asserts) | chat-log write (code asserts only) |
| **me** | `test-me-e2e.js` | `What do you know about me?` (fixture profile) | other phrasings |
| **read** | `test-read-e2e.js` | first config.json read | line-limited read |
| **go-read** | `test-go-read-e2e.js` | first ls/pwd/cat case | others |
| **core** | `test-core-e2e.js` | first ls/pwd/cat case | others |
| **write** | `test-write-e2e.js` | first write + file on disk | other write phrasings |
| **edit** | `test-edit-e2e.js` | first edit + file changed | other edits |
| **go-write** | `test-go-write-e2e.js` | touch creates file | copy (depends on prior test) |
| **apply-patch** | `test-apply-patch-e2e.js` | first patch + file changed | replace line |
| **vision** | `test-vision-e2e.js` | first generate | second generate |
| **speech** | `test-speech-e2e.js` | first synthesize | voice reply |
| **cron** | `test-cron-e2e.js` | job-count / run-job / channel (code asserts) | list/add/manage (judge only) |
| **basic** | `test-basic-e2e.js` | two-part + three-part (tools used) | greeting (no tools) |

Skills without E2E chat tests (`test-gmail-skill.js`, `test-github-skill.js`, etc.) use direct executor asserts instead of `expectMode`.
