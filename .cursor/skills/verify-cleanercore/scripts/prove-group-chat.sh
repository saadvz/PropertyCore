#!/usr/bin/env bash
# Prove the Cleaner Core group thread through doctor and smoke.
# No arguments. Never texts a phone. Overwrites evidence/group-chat.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  printf '%s\n' "prove-group-chat.sh takes no arguments and accepts no phone number." >&2
  exit 1
fi

export NODE_OPTIONS="${NODE_OPTIONS:-} --disable-warning=ExperimentalWarning"

ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
EVIDENCE="$SKILL/evidence/group-chat"
rm -rf "$EVIDENCE"
mkdir -p "$EVIDENCE"
cd "$ROOT"

if [[ ! -x node_modules/.bin/tsx ]]; then
  printf '%s\n' "tsx is missing. From the repo root run: npm ci" >&2
  exit 1
fi

FEED="$ROOT/src/cleaner-core/fixtures/guesty-lite-scratch.ics"
OWNER="+15555550100"
CLEANER="+15555550101"
EXTRA="+15555550122"

fail() {
  printf '%s\n' "$1" | tee "$EVIDENCE/result.txt" >&2
  printf '%s\n' "evidence: $EVIDENCE" >&2
  exit 1
}

doctor() {
  mkdir -p "$EVIDENCE/doctor"
  printf '%s\n' "env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor" >"$EVIDENCE/doctor/doctor.command"
  set +e
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor >"$EVIDENCE/doctor/doctor.stdout.txt" 2>"$EVIDENCE/doctor/doctor.stderr.txt"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$EVIDENCE/doctor/doctor.exit"
  if [[ "$code" != "0" ]]; then
    fail "doctor exit $code"
  fi
  if ! node "$SKILL/scripts/assert-report.mjs" doctor "$EVIDENCE/doctor/doctor.stdout.txt" "$SKILL/scripts/expected/doctor-on.json" forbidden; then
    fail "doctor stdout mismatch"
  fi
}

run_smoke() {
  local dir="$1"
  local name="$2"
  shift 2
  mkdir -p "$dir"
  printf '%s\n' "$*" >"$dir/$name.command"
  set +e
  "$@" >"$dir/$name.stdout.txt" 2>"$dir/$name.stderr.txt"
  local code=$?
  set -e
  printf '%s\n' "$code" >"$dir/$name.exit"
  if [[ "$code" != "0" ]]; then
    fail "$name exit $code"
  fi
  node -e '
    const fs = require("node:fs");
    const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const write = (name, value) => fs.writeFileSync(name, JSON.stringify(value ?? [], null, 2) + "\n");
    fs.writeFileSync(process.argv[2], (report.transcript ?? []).join("\n") + "\n");
    write(process.argv[3], report.jobs);
    write(process.argv[4], report.outbox);
  ' "$dir/$name.stdout.txt" "$dir/$name.transcript.txt" "$dir/$name.jobs.json" "$dir/$name.outbox.json"
}

assert_journey() {
  local name="$1"
  if ! node "$SKILL/scripts/assert-group-chat.mjs" "$name" "$EVIDENCE/$name/smoke.stdout.txt"; then
    fail "feature: $name"
  fi
  printf '%s\n' "feature: $name" >"$EVIDENCE/$name/result.txt"
  printf '%s\n' "pass" >>"$EVIDENCE/$name/result.txt"
}

smoke() {
  env CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- "$@"
}

doctor

BASE=(--with-pin --feed "$FEED" --confirm-times "11:00 AM|4:00 PM" --reply "$OWNER=YES" --reply "$CLEANER=YES")

run_smoke "$EVIDENCE/eligible" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
assert_journey eligible

run_smoke "$EVIDENCE/private" smoke smoke --group-chat --group-extra "$EXTRA" "${BASE[@]}" --reply "$EXTRA=YES" --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
assert_journey private

run_smoke "$EVIDENCE/held" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --reply "$CLEANER=STOP" --reply "$OWNER=guests have left"
assert_journey held

run_smoke "$EVIDENCE/stop-host" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --group-reply "$OWNER=STOP" --group-reply "$CLEANER=Can we do 2:00 PM?"
assert_journey stop-host

run_smoke "$EVIDENCE/resume" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=STOP" --reply "$CLEANER=START" --resume --resume
assert_journey resume

run_smoke "$EVIDENCE/time" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --group-reply "$CLEANER=Let's say 2:00 PM" --group-reply "$OWNER=Sounds good"
assert_journey time

run_smoke "$EVIDENCE/injury" smoke smoke --group-chat "${BASE[@]}" --group-reply "$CLEANER=I fell at 2:00 PM and I'm hurt"
assert_journey injury

run_smoke "$EVIDENCE/problem" smoke smoke --group-chat "${BASE[@]}" --group-reply "$CLEANER=The lock is broken"
assert_journey problem

run_smoke "$EVIDENCE/before-yes" smoke smoke --group-chat --with-pin --feed "$FEED"
assert_journey before-yes

run_smoke "$EVIDENCE/inert" smoke smoke --with-pin --feed "$FEED" --reply "$CLEANER=YES" --reply "$OWNER=YES" --reply "$OWNER=YES" --reply "$CLEANER=YES" --reply "$OWNER=guests have left"
assert_journey inert

run_smoke "$EVIDENCE/done" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --reply "$OWNER=guests have left" --group-reply "$CLEANER=START" --group-reply "$CLEANER=DONE"
assert_journey done

run_smoke "$EVIDENCE/done-without-start" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --reply "$OWNER=guests have left" --group-reply "$CLEANER=DONE" --group-reply "$CLEANER=DONE"
assert_journey done-without-start

run_smoke "$EVIDENCE/twice" smoke smoke --group-chat "${BASE[@]}" --reply "$CLEANER=YES" --reply "$OWNER=guests have left" --reply "$OWNER=guests have left"
assert_journey twice

FAIL_DIR="$(mktemp -d)"
run_smoke "$EVIDENCE/failed" setup smoke --group-chat --with-pin --data "$FAIL_DIR" --feed "$FEED" --confirm-times "11:00 AM|4:00 PM" --reply "$OWNER=YES" --reply "$CLEANER=YES" --reply "$CLEANER=YES"
run_smoke "$EVIDENCE/failed" smoke smoke --group-chat --with-pin --data "$FAIL_DIR" --no-poll --fail-sends 1 --reply "$OWNER=guests have left"
run_smoke "$EVIDENCE/failed" retry smoke --group-chat --with-pin --data "$FAIL_DIR" --no-poll --remind --reply "$OWNER=guests have left"
if ! node "$SKILL/scripts/assert-group-chat.mjs" failed "$EVIDENCE/failed/retry.stdout.txt"; then
  fail "feature: failed"
fi
printf '%s\n' "feature: failed" >"$EVIDENCE/failed/result.txt"
printf '%s\n' "pass" >>"$EVIDENCE/failed/result.txt"
rm -rf "$FAIL_DIR"

mkdir -p "$EVIDENCE/desk"
printf '%s\n' "npx tsx .cursor/skills/verify-cleanercore/scripts/prove-group-desk.ts" >"$EVIDENCE/desk/desk.command"
if ! npx tsx "$SKILL/scripts/prove-group-desk.ts" "$EVIDENCE/desk/desk.json"; then
  fail "desk proof"
fi
node -e '
  const fs = require("node:fs");
  const desk = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const missing = "I can'\''t send the door code yet. Let'\''s finish setting up Cleaner Core first.";
  const sent = "I sent the door code to the cleaner. I'\''ll tell you if it doesn'\''t go through.";
  const again = "I already sent the door code to the cleaner.";
  if (desk.missing !== missing) process.exit(1);
  if (desk.sent !== sent) process.exit(1);
  if (desk.again !== again) process.exit(1);
  if (desk.groupSawCode !== false) process.exit(1);
  if (desk.liveOff !== "no-fetch") process.exit(1);
' "$EVIDENCE/desk/desk.json" || fail "desk replies"
printf '%s\n' "feature: desk" >"$EVIDENCE/desk/result.txt"
printf '%s\n' "pass" >>"$EVIDENCE/desk/result.txt"

if ! node scripts/scan-cleaner-secrets.mjs "$EVIDENCE"; then
  fail "group-chat evidence contains a configured scratch secret"
fi

cat >"$EVIDENCE/result.txt" <<EOF
features: eligible private held stop-host resume time injury problem before-yes inert done done-without-start twice failed desk
script: .cursor/skills/verify-cleanercore/scripts/prove-group-chat.sh
phones: 555 only
pins: redacted
EOF

cat >"$EVIDENCE/stand-in.txt" <<'EOF'
This run used the in-process doctor/smoke CLI and one local desk process. A live cleaning job will not do these steps. They stay unverified until a run on that live target covers them. That run still uses only Scratch test numbers.

1. Started tsx via npm run cleaner:doctor and npm run cleaner:smoke in this checkout. A hosted job is not launched that way.
2. Read the Guesty Lite fixture under src/cleaner-core/fixtures/ and the practice calendar fixture. Did not call Guesty, Google, Notion, or Twilio.
3. Froze time at the smoke default 2026-10-14T15:00:00.000Z. The desk used the same frozen instant.
4. Pushed texts onto an in-memory array, or a JSON file under a temporary --data directory, and printed JSON. The desk group send used a fake fetch that failed. With live texts off, the group did not fetch. Temporary directories were removed after stdout was saved.
5. Applied each --reply and --group-reply inside the process. Neither path received an inbound SMS.
6. Printed no door code. Saved stdout, transcripts, job lists, and the outbox use [redacted].
EOF

printf '%s\n' "$EVIDENCE"
