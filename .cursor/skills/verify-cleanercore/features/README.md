# Cleaner Core verification map

This directory is the maintained source for verifying Cleaner Core's user-facing behavior. Read the index before driving, then use the matching feature file as the recipe.

Without `--with-pin`, the owner receives the schedule text. With `--with-pin`, the opted-in cleaner receives the offer, the confirmation, and the reminder, and only that cleaner's YES confirms the job. The approved cleaner still receives injury replies. HELP does not get a reply from this code. A drive without `--with-pin` does not text a door code. `--with-pin` texts the private door code to the approved cleaner only after the host says the guests have left, and the saved record redacts the digits. The landlord's switch is `CLEANER_CORE_ENABLED`.

## Baseline preconditions

- Repo root of this checkout, Node 22.13 or newer, `node_modules/.bin/tsx` present (`npm ci` when it is not).
- Default doctor and smoke do not read `TOURCORE_HOME`. A journey that says `--data` uses only that temporary directory.
- Scratch Lane recipients are only `+15555550100` (owner) and `+15555550101` (approved cleaner). `+15555550199` may be a reply sender and must not be a recipient. Scratch Court recipients are only `+15555550110` (owner) and `+15555550111` (approved cleaner). `+15555550119` may be a reply sender and must not be a recipient. A drive for one tenant must not text the other. All of these are Scratch 555 numbers. Never type a real person's number.
- Run doctor in the same flag setting as the drive and require `sends` false.
- Each command is a fresh process. Do not reuse a shell that still has `CLEANER_CORE_ENABLED` set when the recipe says unset.
- Never drive `sendblue:*` or any other live messaging script from this map.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Treat every command as literal. Keep the flag assignment and the npm script unchanged.
- Flag on: `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:doctor` and `CLEANER_CORE_ENABLED=1 npm run --silent cleaner:smoke`.
- Replies: `npm run cleaner:smoke -- --reply +15555550100=STOP`. Repeat `--reply` for each inbound text. A reply text that starts with `@` names a fixture file. Any explicit operation (`--reply`, `--feed`, `--then-feed`, `--google`, `--notion`, `--onboard`, `--group-mode`, `--group-capable`, `--participant`, `--tenant`, `--closed`, `--now`, `--remind`, `--fail-sends`, `--data`, `--no-poll`, `--with-pin`, `--unapproved`, `--group`, `--group-chat`, `--group-extra`, `--group-reply`, `--confirm-times`, `--resume`) does not also inject YES.
- Flag off: `env -u CLEANER_CORE_ENABLED` in front of the same scripts.
- Assert the full stdout document and the exit code. A truthy `ok` is not a result.
- After smoke, every `+1` number in stdout must be a Scratch test number: area code 555, or exchange 555 with line 0100–0199.
- A drive without `--with-pin` leaves `pinRecipients` empty. Its stdout, job list, outbox, and persisted store contain no door code. A `--with-pin` drive may list `+15555550101` in `pinRecipients`. Its saved stdout, transcript, outbox, and store replace the scratch digits with `[redacted]`.
- Do not remove proof artifacts during cleanup. A temporary `--data` directory is removed only after its stdout is saved.

## Proof and skip reporting

- Capture the command, stdout, stderr, and exit code under `.cursor/skills/verify-cleanercore/evidence/<UTC timestamp>/`.
- Record the feature id and the entry point in that directory's `result.txt`.
- Default smoke stdout is the record of texts. Step D through G journeys also save the transcript, the job list, and the outbox from that stdout.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path. Flag-on smoke with no operation confirms the built-in turnover. That is not proof of STOP, a feed change, a block, or a failed send.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the cleaner doctor/smoke CLI` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Same-day turnover offer and confirm](./same-day-turnover.md) covers the Scratch Lane host questions, the offer, and the owner's YES confirm. `prove-turnover.sh`.
- [No door code](./door-code.md) covers the confirmed turnover and an unapproved YES. Neither texts a door code. `prove-turnover.sh` and `prove-safety.sh`.
- [STOP, HELP, and injury](./stop-help-injury.md) covers opt-out, a HELP text that sends nothing, and one emergency reply per sender on the built-in job. `prove-safety.sh`.
- [Flag off sends nothing](./flag-off.md) covers doctor and smoke with `CLEANER_CORE_ENABLED` unset. `prove-safety.sh`.
- [Read the Guesty Lite feed](./read-feed.md) covers checkout, next check-in, a free night, a same-day turn, and a block that is not a departure. `test/cleanerCore.test.ts`.
- [Host time wins](./host-time.md) covers a host clock that stays after a later feed publishes a different clock. `test/cleanerCore.test.ts`.
- [Corrected time](./corrected-time.md) covers the update text after an offer, with the old offer left behind. `test/cleanerCore.test.ts`.
- [One reminder](./reminder-once.md) covers one reminder across a second poll and a restart. `test/cleanerCore.test.ts`.
- [Blocks create no job](./blocks.md) covers an owner block and a blocked date. `test/cleanerCore.test.ts`.
- [One live job](./one-live-job.md) covers a removed stay: the job list after the change, not only the outbox. `test/cleanerCore.test.ts`.
- [STOP silences later texts](./stop-silences.md) covers opt-out, then a feed change and a reminder, with no new text to the owner. `test/cleanerCore.test.ts`.
- [Persisted store has no door code](./no-pin.md) covers a confirmed job whose stdout and store omit the scratch door code. `test/cleanerCore.test.ts`.
- [Safety replies in new states](./safety-states.md) covers STOP, a quiet HELP, and one emergency phrase while waiting, after the host confirms both times, and after a corrected-time text. `test/cleanerCore.test.ts`.
- [Failed send is not delivered](./failed-send.md) covers a reminder whose first send fails and whose retry sends it once. `test/cleanerCore.test.ts`.
- [Door code only after departure](./pin-after-departure.md) covers a same-day turn that holds the code until the host says the guests have left, then sends it once. `prove-step-d.sh`.
- [Approved and opted in](./opted-in-only.md) covers no code without a cleaner YES, no code for `+15555550199`, and no opt-in for an unapproved cleaner. `prove-step-d.sh`.
- [Later checkout holds the code](./checkout-moved.md) covers a checkout moved to 2:00 PM and a code that waits for the cleaner's new YES. `prove-step-d.sh`.
- [One full Scratch turn](./full-turn.md) covers opt-in, the cleaner's YES, the cleaner reminder, departure, the private text, START, and DONE. `prove-step-d.sh`.
- [DONE without START](./done-without-start.md) covers DONE after the private text, one host line, a second DONE, and DONE before the private text. `prove-step-d.sh`.
- [Sealed door code](./pin-stored.md) covers a persisted store and a stdout that redact the digits. `prove-step-d.sh`.
- [STOP holds the code](./stop-holds.md) covers STOP before departure and a later START that does not send the code. `prove-step-d.sh`.
- [HELP around the door code](./help-while-cleaning.md) covers a quiet HELP, a host injury, and a cleaner injury while waiting, after the code, and in progress, plus a failed host alert. `prove-step-d.sh`.
- [Failed door-code send](./pin-failed.md) covers a failed private send, one retry, and a second reminder that sends nothing. `prove-step-d.sh`.
- [No group and no code for Cory](./no-group.md) covers a group number that receives nothing and a host notice that omits the code. `prove-step-d.sh`.
- [Google Calendar read](./source-read.md) covers a closed read of one fixture stay and the Sunday checkout question. `prove-step-e.sh`.
- [Closed sync](./closed-sync.md) covers a read, a checkout change, and a second sync that sends nothing. `prove-step-e.sh`.
- [Removed Google event](./removed-event.md) covers the existing cancel sentence after the event disappears. `prove-step-e.sh`.
- [One booking, two sources](./one-booking.md) covers one job when Guesty Lite and Google Calendar show the same stay. `prove-step-e.sh`.
- [Google block](./google-block.md) covers an owner block that is not a departure. `prove-step-e.sh`.
- [Wrong tenant calendar](./wrong-tenant.md) covers Scratch Lane refusing Scratch Court's calendar. `prove-step-e.sh`.
- [Two Scratch tenants](./tenant-isolation.md) covers one shared folder, separate phones, a wrong-tenant departure that sends nothing, and each house's door code going once to that house's cleaner. Scratch Court's code follows a Google Calendar stay. `prove-step-e.sh`.
- [Notion permission denied](./notion-permission-denied.md) covers a missing Notion permission, an empty job list, and no cleaning text. `prove-step-f.sh`.
- [Notion booking read](./notion-source-read.md) covers one Notion stay, the Sunday checkout question, and an owner block that is not a departure. `prove-step-f.sh`.
- [Notion sync repeat](./notion-sync-repeat.md) covers three reads and a restart that send the checkout question once. `prove-step-f.sh`.
- [Removed Notion row](./notion-removed.md) covers one cleaner reminder and the existing cancel sentence, both sent to the opted-in cleaner. `prove-step-f.sh`.
- [Notion job texts stay with the cleaner](./notion-cleaner-routing.md) covers a host YES that does not schedule a Notion job. `prove-step-f.sh`.
- [No offer until the cleaner opts in](./group-no-optin.md) covers a native group that holds the job and tells the host. `prove-step-f.sh`.
- [One booking, Guesty and Notion](./multi-source-dedupe.md) covers one job when Guesty Lite and Notion show the same stay. `prove-step-f.sh`.
- [Full onboarding](./onboarding-full.md) covers a new property activated only after opt-in and APPROVE. `prove-step-f.sh`.
- [Onboarding without opt-in](./onboarding-no-optin.md) covers APPROVE with no cleaner YES. Nothing is activated and no cleaning text is sent. `prove-step-f.sh`.
- [Consented group text](./group-native-consented.md) covers one group offer after every participant opts in. `prove-step-f.sh`.
- [Mirrored group fallback](./group-mirrored-fallback.md) covers labeled copies when a group cannot be sent. `prove-step-f.sh`.
- [Unconsented participant left out](./group-unconsented-participant.md) covers a participant who never opts in, then that number's STOP and HELP. `prove-step-f.sh`.
- [Door code stays private](./pin-private-only.md) covers a door code that is not sent to a group, an observer, a mirror, or an unapproved number. `prove-step-f.sh`.
- [Notion tenants stay apart](./notion-tenant-isolation.md) covers Lane, Court, and an onboarded property in one folder. `prove-step-f.sh`.
- [STOP, HELP, and injury after a Notion read](./notion-stop-help-injury.md) covers the same safety replies after a Notion checkout question. `prove-step-f.sh`.
- [Observer injury inside a group](./observer-injury-group.md) covers the 911 reply and the host alert from an opted-in observer. `prove-step-f.sh`.
- [Observer injury outside a group](./observer-injury-solo.md) covers the same injury path when texts are one-to-one. `prove-step-f.sh`.
- [Owner injury](./owner-injury.md) covers the 911 line to the host, with no alert back to that host. `prove-step-f.sh`.
- [Injury wordings](./injury-wording.md) covers hurt, injury, blood, and fall phrases from the cleaner and the observer, in a group and one-to-one. `prove-step-f.sh`.
- [CI both ways](./g-ci-local.md) covers typecheck, the full suite (including the cleaner-core flag tests), the secret scan, and the proofs in `scripts/ci-proofs.sh`. `prove-step-g.sh`.
- [Stale feed](./g-stale-source.md) covers one host alert and no offer until a fresh read. `prove-step-g.sh`.
- [Host time beats a stale feed](./g-host-override.md) covers a 2:00 PM host clock that a stale feed does not replace. `prove-step-g.sh`.
- [Private door code and exposure review](./g-permanent-code.md) covers the redacted private send, group and mirror copies, and one exposure review. `prove-step-g.sh`.
- [Backup restore](./g-backup-restore.md) covers a restored opt-out that sends nothing, with Court left in place. `prove-step-g.sh`.
- [Replay sends nothing](./g-replay.md) covers a second process that replays a finished turn. `prove-step-g.sh`.
- [Restart](./g-recovery.md) covers an uncertain offer and one door code after a saved clearance. `prove-step-g.sh`.
- [Review queue](./g-review-queue.md) covers each review kind once, plus the Airbnb phrase. `prove-step-g.sh`.
- [Health](./g-observability.md) covers counters, a health command that does not send, and a redacted log. `prove-step-g.sh`.
- [Step G tenants](./g-tenant-isolation.md) covers Lane and Court reviews, backups, replays, and health counts. `prove-step-g.sh`.
- [STOP, HELP, and injury under step G](./g-stop-help-injury.md) covers the step F safety replies again. `prove-step-g.sh`.
- [Group thread for the host and the cleaner](./group-chat.md) covers opt-in, the group door code, the private fallback, STOP, resume, a group time, injury, and a hold. `prove-group-chat.sh`.
- [Supplies](./supplies.md) covers the DONE supplies question, the cleaner's answer, report_low, a go cart, and a made-up order. `prove-supplies.ts`.
