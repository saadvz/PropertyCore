---
name: verify-cleanercore
description: "Drive Cleaner Core (src/cleaner-core) through its doctor and smoke CLI to prove Scratch Lane host times, feed changes, reminders, safety replies, the step D private door code, step E's second calendar and second Scratch tenant, step F's Notion source, onboarding, and group delivery, and step G's stale feed, review queue, backup, replay, and restart. Use when changing CLEANER_CORE_ENABLED, turnover texts, the door code, STOP/START/injury handling, step C reconciliation, Google Calendar fixtures, Notion fixtures, onboarding, group texts, tenant isolation, freshness, reviews, or backups. Sends nothing to a real phone. A smoke run without --with-pin does not text a door code. HELP gets no reply from this code. Step E uses fixture calendars, not a Google account. Step F uses Notion fixtures, not a Notion account. Step G uses the same fixtures and does not call a live provider. Before a live run, the preflight checks the Railway connector, the Twilio inbound webhook, and a carrier STOP block."
---

# Verify Cleaner Core

Cleaner Core texts one Scratch Lane turnover after the owner confirms the checkout time and the check-in time. With `--with-pin`, the opted-in cleaner receives the offer, the confirmation, and the reminder, and that cleaner's YES confirms the job. The surface an agent can drive is the doctor/smoke CLI (`npm run cleaner:doctor`, `npm run cleaner:smoke`). There is no web UI and no listening port. The flag `CLEANER_CORE_ENABLED` is off unless it is `1` or `true`.

Drive only Scratch test numbers. Scratch Lane is `+15555550100` (owner) and `+15555550101` (approved cleaner) at 12 Scratch Lane. `+15555550199` may send a reply and must not receive a text. Scratch Court is the second tenant: `+15555550110` (owner), `+15555550111` (approved cleaner), and `+15555550119` (unapproved) at 8 Scratch Court. Step F onboarding uses `+15555550120` (owner), `+15555550121` (cleaner), and `+15555550122` (observer) at 9 Scratch Annex. A drive for one property must not text another property. If a report texts any other phone, stop. Do not run `sendblue:*`, do not point the CLI at a live provider, and do not substitute a real person's number. Step E does not call Google. Step F does not call Notion.

A smoke run without `--with-pin` is step C. It never texts a door code and never marks a job ready from calendar time. `--with-pin` is step D: the private text goes to the approved cleaner only after the host says the guests have left, and the saved evidence replaces the scratch digits with `[redacted]`. A new evidence directory that contains those digits fails the proof. No job status is `ready`.

## Preflight

Doctor and smoke do not call the live service. Before a live run, check the connector and the phone line. These three checks have no test.

- The connector points at the Cleaner Core service named by `hostedCleanerCoreUrl` in `cleaner-template/template.json`: the multi-tenant service `https://tourcore-production-8b80.up.railway.app`. A live run uses a test tenant on its `/admin` page, never a real host's.
- The Twilio inbound webhook is set.
- A carrier STOP block (Twilio error 21610) is cleared by that phone texting START.

## Launch

This CLI is short-lived. Launch means install dependencies once, then start each drive as its own process.

From the repo root, with Node 22.13 or newer (the package and the SQLite backup store need it):

```
npm ci
```

Skip `npm ci` when `node_modules/.bin/tsx` is already executable.

Do not wrap doctor or smoke in tmux. Neither command is a TUI. Each one prints one JSON document and exits. That exit is the ready signal for doctor, and the proof for smoke. Two drives may run at the same time when they do not share a `--data` directory. They share no port.

The default smoke process keeps its sink in memory. Journeys that must survive a second process pass `--data <dir>`. That directory is a temporary store for the proof. Delete it after the stdout, transcript, job list, and outbox are saved. Do not delete the evidence directory.

## Doctor

Run doctor before every drive, in the same flag setting as that drive. It is read-only. `sends` is always false. Doctor does not text anyone.

Flag on, which is the setting for a turnover drive:

```
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor
```

Stdout must be exactly `scripts/expected/doctor-on.json` in this skill, and the exit code must be 0:

```json
{
  "ok": true,
  "enabled": true,
  "sends": false,
  "note": "Cleaner Core is on. doctor does not send texts."
}
```

Flag off uses `env -u CLEANER_CORE_ENABLED` and the doctor document in [features/flag-off.md](features/flag-off.md). A flag-on doctor does not prove the flag-off journey.

If doctor exits non-zero, or `sends` is not false, do not run smoke. The process has already exited. Fix the checkout and run doctor again.

## Drive

The harness is `npm run cleaner:doctor` and `npm run cleaner:smoke`. Pass replies, step C operations, step D flags, and step F flags after `--`:

```
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=STOP --reply +15555550100=YES
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550100=HELP
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply "+15555550100=I fell and I'm hurt" --reply "+15555550100=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt" --reply "+15555550101=I fell and I'm hurt"
CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke -- --reply +15555550199=YES
env -u CLEANER_CORE_ENABLED npm run --silent cleaner:doctor
env -u CLEANER_CORE_ENABLED npm run --silent cleaner:smoke -- --reply +15555550100=YES
```

A cleaner or host text of HELP does not get a reply from this code. Twilio answers HELP. The job stays as it was, HELP does not count as YES, START, or DONE, and it does not resume a held job. STOP and START still do.

`--reply <from>=<text>` is repeatable. `from` is a Scratch test number. The text is everything after the first `=`. A text that starts with `@` is a path, and smoke reads that file inside the process. When any explicit operation is present (`--reply`, `--feed`, `--then-feed`, `--google`, `--notion`, `--onboard`, `--group-mode`, `--group-capable`, `--participant`, `--tenant`, `--closed`, `--now`, `--remind`, `--fail-sends`, `--data`, `--no-poll`, `--with-pin`, `--unapproved`, `--group`), smoke does not inject YES. With no operation, smoke polls the built-in same-day iCal and injects three YES replies from `+15555550100`: checkout, check-in, then a YES that does not schedule a cleaning. No cleaner has opted in, so the host gets one hold note and no offer. That stdout must match `scripts/expected/smoke-turnover.json`. Exit code 0. `pinRecipients` is `[]`. No body contains a door code.

`--with-pin` opts the approved cleaner in and can send the private door code after the host says the guests have left. Smoke stdout, the transcript, and the outbox print that code as `[redacted]`. `--unapproved` leaves the cleaner unapproved, so no opt-in and no door code go out. `--group` takes one Scratch test number and that number must not receive the door code. The host notice is `Door code sent to the cleaner.`

Smoke with the flag unset exits 2 and prints `sent: []`, including when `--reply` is a Scratch YES. See the feature files for the literal documents.

A Scratch test number is E.164 `+1` whose national number either has area code 555, or exchange 555 and line 0100–0199. `+15555550100`, `+15555550101`, `+15555550199`, `+15555550110`, `+15555550111`, and `+15555550119` qualify. Any other `--reply` from fails the process, writes the refusal on stderr, and prints no JSON.

Any other argument fails the same way. `npm run cleaner:smoke -- STOP` exits 1, writes `Unexpected argument STOP` on stderr, and does not book the turnover. Do not pass a real phone.

The ten step C journeys (feed read, host time, corrected time, one reminder, blocks, one live job, STOP silences, no door code, safety states, failed send) are unit tests in `test/cleanerCore.test.ts`. The old `prove-step-c.sh` assumed the host's own number took the offer without a cleaner opting in, which steps D and G replaced, so it was retired.

The step D blockers are one script. It overwrites the fixed directory `evidence/step-d/` and does not add a timestamp:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-d.sh
```

The step E blockers are one script. It overwrites the fixed directory `evidence/step-e/` and does not add a timestamp:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-e.sh
```

The step F blockers are one script. It overwrites the fixed directory `evidence/step-f/` and does not add a timestamp:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-f.sh
```

The step G safety gates are one script. It overwrites the fixed directory `evidence/step-g/` and does not add a timestamp:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh
```

Payments are one desk drive: setup with $85 to the made-up Venmo username `scratch-cleaner`, DONE, the checklist YES, `check_now`'s `payDue`, and `mark_paid`. It exits non-zero unless the pay link is exact and no payment step sent a text. It never opens Venmo; opening a link on a phone is a manual check, stopped before Pay:

```
npx tsx .cursor/skills/verify-cleanercore/scripts/prove-payments.ts .cursor/skills/verify-cleanercore/evidence/payments/payments.json
```

Supply Core is one desk drive: a cleaning property with Supply Core on and one made-up item, DONE with the combined supplies question, the cleaner's answer, `check_now`'s `supply-report`, `report_low`, `check_supplies`, a go cart, and a made-up order number. It exits non-zero unless every step matches, every recipient is a Scratch number, and the door code appears nowhere. It never opens a store; see [features/supplies.md](features/supplies.md):

```
npx tsx .cursor/skills/verify-cleanercore/scripts/prove-supplies.ts .cursor/skills/verify-cleanercore/evidence/supplies/supplies.json
```

## Evidence

Write one directory per turnover or safety run:

`.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/`

Step D, step E, and step F are the exceptions. `prove-step-d.sh` overwrites `.cursor/skills/verify-cleanercore/evidence/step-d/`. `prove-step-e.sh` overwrites `.cursor/skills/verify-cleanercore/evidence/step-e/`. `prove-step-f.sh` overwrites `.cursor/skills/verify-cleanercore/evidence/step-f/`. None of them creates a timestamped folder.

Keep the command, stdout, stderr, and exit code for doctor and for the drive. Name the feature id in `result.txt`. Assert the literal JSON files under `scripts/expected/` for the default turnover and the safety journeys. The transcript lists each outbound body and each inbound Scratch reply, as `+15555550100: YES`. Assert every `+1` number in smoke stdout is a Scratch test number. A Scratch Lane recipient is `+15555550100` or `+15555550101`. A Scratch Court recipient is `+15555550110` or `+15555550111`. A drive without `--with-pin` requires `pinRecipients` empty and the scratch door code absent from the saved stdout. `prove-step-d.sh` overwrites `evidence/step-d/` and fails if those digits appear there. The phrase `door code` is allowed in that folder only as the redacted private text and the host notice. `prove-step-e.sh` overwrites `evidence/step-e/` and fails if a scratch pin loaded from `src/cleaner-core/tenants.ts` appears there. `prove-step-f.sh` overwrites `evidence/step-f/` and fails if a scratch pin loaded from `src/cleaner-core/tenants.ts` or the annex lock fixture appears there. The Annex lock reply is an `@` path, not the digits. `prove-step-g.sh` overwrites `evidence/step-g/` and fails if a configured scratch code appears there. The exposure reply is an `@` path to a temporary file that is deleted.

The default smoke process exits and leaves the in-memory sink behind. The saved stdout is the record of what that sink accepted. Journeys that pass `--data` also persist `cleaner-core.json` for the life of that directory. Capture stdout before removing the temporary directory. Cleanup must not delete the evidence directory.

The smoke command is a stand-in for a live cleaning job. It does five things a live job will not. Those stay unverified until a run on the live target covers them, and that run still uses only Scratch test numbers:

1. It starts `tsx` on this checkout (`npm run cleaner:smoke`). A hosted job is not launched that way.
2. The default drive reads the iCal fixture inside `src/cleaner-core/cli.ts`. Step C drives read fixture files under `src/cleaner-core/fixtures/`. Neither fetches a Guesty Lite URL.
3. It freezes time at `2026-10-14T15:00:00.000Z`, or at the `--now` instant a journey passes. It does not use the wall clock.
4. It pushes texts onto an in-memory array, or a JSON file under `--data`. It does not call a messaging provider.
5. It applies replies inside the process. With no operation, those replies are three YES texts from `+15555550100`. With `--reply`, those replies are applied in order and YES is not added. Neither path receives an inbound SMS.

## Cleanup

Doctor and smoke exit on their own. Do not kill by process name. If a run you started is stuck, kill that process's pid and leave every other process alone.

Do not delete `.cursor/skills/verify-cleanercore/evidence/`. Remove only a temporary `--data` directory the proof created, and only after its stdout is saved.

## Helpers

Prove the same-day turnover (feature `same-day-turnover`) with:

```
.cursor/skills/verify-cleanercore/scripts/prove-turnover.sh
```

The script takes no arguments. It runs the flag-on doctor command, requires the expected doctor JSON and exit 0, then runs the flag-on smoke command and requires `scripts/expected/smoke-turnover.json`, exit 0, Scratch recipients, and no door code. It writes the evidence directory and prints that path.

Prove the safety journeys with:

```
.cursor/skills/verify-cleanercore/scripts/prove-safety.sh
```

That script also takes no arguments. It doctors, then drives, in this order: `flag-off`, `stop`, `help`, `injury`, `unapproved-yes`. Each journey gets a subdirectory with the command, stdout, stderr, exit code, and `result.txt`. Flag-off smoke must exit 2 and match `scripts/expected/smoke-off.json`. The other four must exit 0 and match `smoke-stop.json`, `smoke-help.json`, `smoke-injury.json`, and `smoke-unapproved.json`. All five forbid a door code. The script prints each subdirectory path.

Prove the step D blockers with:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-d.sh
```

That script takes no arguments. It removes `evidence/step-d/` and writes it again. It doctors before each journey, then drives `held`, `released`, `not-opted`, `unapproved-yes`, `not-approved`, `checkout-moved`, `full-turn`, `done-without-start`, `done-early`, `pin-stored`, `stop-holds`, `help-waiting`, `help-cleared`, `help-progress`, `injury-failed`, `pin-failed`, and `no-group`. The help journeys send no HELP reply. The injury replies stay, and the job status stays `awaiting_departure`, `cleared`, or `in_progress`. `done-without-start` finishes from DONE after the private text and sends one host line. `done-early` answers DONE before that text and does not finish the job. The script prints `evidence/step-d`.

Prove the step E blockers with:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-e.sh
```

That script takes no arguments. It removes `evidence/step-e/` and writes it again. It doctors before each journey, then drives `source-read`, `closed-sync`, `removed`, `one-job`, `block`, `wrong-tenant`, and `tenant-isolation`. The Google files are fixtures. `tenant-isolation` runs both Scratch tenants to a confirmed departure in one `--data` directory. A "guests have left" from the other house sends nothing. Scratch Court's Google stay is the one that reaches the private text. The script prints `evidence/step-e`.

Prove the step F blockers with:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-f.sh
```

That script takes no arguments. It removes `evidence/step-f/` and writes it again. It doctors before each journey, then drives `notion-permission-denied`, `notion-source-read`, `notion-sync-repeat`, `notion-removed`, `notion-cleaner-routing`, `group-no-optin`, `multi-source-dedupe`, `onboarding-full`, `onboarding-no-optin`, `group-native-consented`, `group-mirrored-fallback`, `group-unconsented-participant`, `pin-private-only`, `tenant-isolation`, `stop-help-injury`, `observer-injury-group`, `observer-injury-solo`, `owner-injury`, and `injury-wording`. The Notion files are fixtures. `tenant-isolation` reads Lane and Court, activates Annex, and reads Lane again in one `--data` directory. `injury-wording` sends hurt, injury, blood, and fall phrases from the cleaner and the observer in one-to-one mode and in a group, and records one everyday text without asserting it. The script prints `evidence/step-f`.

Prove the step G safety gates with:

```
.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh
```

That script takes no arguments. It removes `evidence/step-g/` and writes it again. It doctors before each journey, then drives `stale-source`, `host-override-beats-stale-feed`, `permanent-code`, `backup-restore`, `replay-no-resend`, `recovery-after-restart`, `review-queue`, `observability`, `tenant-isolation`, and `stop-help-injury`. It then reruns `prove-step-d.sh`, `prove-step-e.sh`, and `prove-step-f.sh`, then `scripts/ci-check.sh` and a flag-off smoke. The default stale threshold is three hours. `npm run cleaner:health` does not send. The script prints `evidence/step-g`.

Prove the group thread with:

```
.cursor/skills/verify-cleanercore/scripts/prove-group-chat.sh
```

That script takes no arguments. It removes `evidence/group-chat/` and writes it again. It doctors once, then drives `eligible`, `private`, `held`, `stop-host`, `resume`, `time`, `injury`, `problem`, `before-yes`, `inert`, `done`, `twice`, and `failed`, then one local desk run for the missing key, the failed group send, and the already-sent reply. Phones stay on area code 555. The script prints `evidence/group-chat`.

After any script exits, its evidence directory must still be on disk. A cleanup that removes it fails the proof.

## Feature map

Read [features/README.md](features/README.md) before driving. One feature file is one user journey. `prove-turnover.sh` drives `same-day-turnover`. `prove-safety.sh` drives flag-off, STOP, HELP, injury, and the unapproved YES. `prove-step-d.sh` drives the step D blockers and overwrites `evidence/step-d`. `prove-step-e.sh` drives the step E blockers and overwrites `evidence/step-e`. `prove-step-f.sh` drives the step F blockers and overwrites `evidence/step-f`. `prove-step-g.sh` drives the step G safety gates and overwrites `evidence/step-g`. `prove-group-chat.sh` drives the group thread and overwrites `evidence/group-chat`. `prove-supplies.ts` drives [supplies](features/supplies.md) and overwrites `evidence/supplies/supplies.json`. Do not mark a feature verified because a different feature's stdout happened to contain a related field.

When the map changes, run `/maintain-verification-skill` against `verify-cleanercore`.
