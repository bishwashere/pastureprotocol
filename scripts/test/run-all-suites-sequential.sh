#!/usr/bin/env bash
# Run each test suite once, sequentially. Prints structured blocks for reporting.
set -uo pipefail
cd "$(dirname "$0")/../.."

run_suite() {
  local name="$1"
  shift
  echo "@@@@@@ SUITE_START $name @@@@@@"
  echo "@@@@@@ CMD $* @@@@@@"
  local out
  local code=0
  out=$("$@" 2>&1) || code=$?
  echo "$out"
  echo "@@@@@@ EXIT $code @@@@@@"
  echo "@@@@@@ SUITE_END $name @@@@@@"
  return $code
}

# package.json scripts (dedupe agent-send/agent-title → agent-team-e2e only once)
for script in \
  workspace-path e2e-expect conversation-context chat-session \
  home-assistant-format retrospective memory-index-files session-bootstrap \
  workspace-chat-days background-tasks tide-checklist tide update-build \
  skill-install github-skill gmail-skill calendar-skill home-assistant-format \
  browser dry-run telegram-send intent-planner agent-team-e2e \
  browser-e2e write-e2e edit-e2e me-e2e \
  cron-e2e memory-e2e home-assistant-e2e; do
  run_suite "pnpm test:$script" pnpm run "test:$script" || true
done

# not in package.json
for pair in \
  "agent-map-ui|node scripts/test/unit/agent/test-agent-map-ui.js" \
  "apply-patch|node scripts/test/unit/skills/test-apply-patch.js" \
  "credential-utils|node scripts/test/unit/core/test-credential-utils.js" \
  "fixture-state|node scripts/test/support/test-fixture-state.js" \
  "read-e2e|node scripts/test/e2e/real/skills/test-read-e2e.js" \
  "search-e2e|node scripts/test/e2e/real/skills/test-search-e2e.js" \
  "core-e2e|node scripts/test/e2e/real/skills/test-core-e2e.js" \
  "go-read-e2e|node scripts/test/e2e/real/skills/test-go-read-e2e.js" \
  "go-write-e2e|node scripts/test/e2e/real/skills/test-go-write-e2e.js" \
  "apply-patch-e2e|node scripts/test/e2e/real/skills/test-apply-patch-e2e.js" \
  "speech-e2e|node scripts/test/e2e/real/skills/test-speech-e2e.js" \
  "vision-e2e|node scripts/test/e2e/real/skills/test-vision-e2e.js" \
  "gog-e2e|node scripts/test/e2e/real/skills/test-gog-e2e.js" \
  "basic-e2e|node scripts/test/e2e/real/core/test-basic-e2e.js" \
  "agent|node scripts/test/e2e/real/agent/test-agent.js" \
  "server-inspect-e2e|node scripts/test/e2e/real/skills/test-server-inspect-e2e.js"; do
  name="${pair%%|*}"
  cmd="${pair#*|}"
  run_suite "$name" $cmd || true
done
