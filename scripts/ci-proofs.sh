#!/usr/bin/env bash
# The Cleaner Core proofs from .cursor/skills/verify-cleanercore. CI runs them in their own job,
# next to the job that runs scripts/ci-check.sh.
# They drive the doctor/smoke CLI on 555 Scratch numbers only and never call a live provider.
# Evidence lands in .cursor/skills/verify-cleanercore/evidence/, which git ignores.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
SCRIPTS=.cursor/skills/verify-cleanercore/scripts
mkdir -p ci-logs

for proof in prove-turnover prove-safety prove-step-d prove-step-e prove-step-f prove-step-g prove-group-chat; do
  printf '%s\n' "== $proof"
  # The loop stops at the first failure, so prove-step-g runs only after step D, E, and F passed here.
  # CLEANER_CI_REGRESSIONS_DONE tells it not to run those three again.
  if ! CLEANER_CI_CHECK_DONE=1 CLEANER_CI_REGRESSIONS_DONE=1 bash "$SCRIPTS/$proof.sh" >"ci-logs/$proof.log" 2>&1; then
    printf '%s\n' "$proof failed" >&2
    tail -n 80 "ci-logs/$proof.log" >&2
    exit 1
  fi
  printf '%s\n' "$proof ok"
done
