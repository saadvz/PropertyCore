#!/usr/bin/env bash
# Commands the Cleaner Core CI job runs after checkout and npm ci.
# Node 22 is required for the SQLite backup store (node:sqlite).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p ci-logs

# GitHub Actions turns colour on for the test runner. Plain logs keep the secret scan's
# timing patterns and the test-count line at the end matching the same text as locally.
export NO_COLOR=1

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) { console.error(`Cleaner Core SQLite backups need Node 22.13 or newer. This process is Node ${process.version}.`); process.exit(1); }'

run_log() {
  local name="$1"
  shift
  printf '%s\n' "== $name"
  if ! "$@" >"ci-logs/$name.log" 2>&1; then
    printf '%s\n' "$name failed" >&2
    tail -n 80 "ci-logs/$name.log" >&2
    exit 1
  fi
  printf '%s\n' "$name ok"
}

# The checks that take seconds go first, so a failure there shows before the test suite runs.
printf '%s\n' "== SETUP_PROMPT unchanged"
git fetch origin master --depth=1
git diff --exit-code origin/master -- grok-template/SETUP_PROMPT.md
printf '%s\n' "SETUP_PROMPT ok"

run_log tracked-scan node scripts/scan-cleaner-secrets.mjs --tracked
run_log typecheck npm run typecheck
run_log build npm run build
# The cleaner-core flag tests set CLEANER_CORE_ENABLED themselves and clear it after each test,
# so they run on and off inside the full suite.
run_log test-default npm test
run_log secret-scan node scripts/scan-cleaner-secrets.mjs ci-logs
run_log test-eval npm run test:eval

printf '%s\n' "test-default $(grep -E 'Tests[[:space:]]+[0-9]+ passed' ci-logs/test-default.log | tail -n 1)"
