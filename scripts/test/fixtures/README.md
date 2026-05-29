# E2E test fixtures

Fixed directory: `state/` - dummy data so all skills have something to work on. Not created at test time; always present in the repo.

## Contents

- **workspace/MEMORY.md** - Test user profile (name, preferences, projects)
- **workspace/memory/preferences.md** - Extra notes for me/memory skills
- **workspace/chat-log/** - Sample dated chat log (for me skill)
- **workspace/e2e-edit-target.txt** - Target file for edit skill tests
- **cron/jobs.json** - Empty cron store

Tests use `prepareStateFromFixture()` from `test-fixture-state.js`: it copies your `~/.cowcode` config and `.env` into a temp dir and overlays this fixture (workspace + cron), so the app has both fixture data and your LLM/config.

**Tests using this fixture:** me (all), edit (target file + reset per test), write. Cron and memory E2E still use their own temp or default state where they need isolated stores or index.
