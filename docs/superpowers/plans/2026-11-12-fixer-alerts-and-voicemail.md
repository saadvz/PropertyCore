# Fixer Core Alerts, Voicemail and Agent Number Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Fixer-only property wakes Grok the moment a pro texts or leaves a voicemail on the account's line, and the host can ask Grok for that line's number.

**Architecture:** Fixer Core gets its own `OperatorEventOutbox` that sends `repairs.update` to the account's existing alerts routine (same per-connection secrets as Cleaner Core's). The hosted service points each line's voice webhook along with its SMS one, answers known callers with a recorded voicemail, and routes Twilio's transcript into Fixer Core's news (or a Cleaner Core note), then deletes the audio. `get_state` carries `agentNumber`.

**Tech Stack:** TypeScript on Node 22.13+, vitest, zod, Twilio REST and TwiML, the existing `src/alerts` outbox.

**Spec:** `docs/superpowers/specs/2026-11-12-fixer-alerts-and-voicemail-design.md`

## Global Constraints

- Tests use only 555 numbers, made-up door codes, `example.com`; Twilio and the routine webhook are stubbed (`setTwilioNumbersFetch`, the outbox's fetch option). Nothing reaches a real phone.
- The routine's address and key (`CLEANER_CORE_ROUTINE_URL`, `CLEANER_CORE_ROUTINE_KEY`) are never returned in a tool reply, logged, or written to a file outside the secret store.
- `repairs.update` events carry exactly `schemaVersion`, `eventId`, `eventType`, `occurredAt`.
- Greeting, verbatim: `Hi, you've reached the repairs and cleaning line. This call is recorded. Please leave your message after the tone, then hang up.`
- Unknown caller, verbatim: `This number doesn't take calls. Please text it.`
- Landlord caller, verbatim: `This line is for your pros and cleaner. Talk to your assistant in chat.`
- `<Record maxLength="120" timeout="5" playBeep="true" transcribe="true" transcribeCallback="<origin>/webhooks/twilio/voice/transcript">`.
- At most 5 recordings per caller per account in the last hour. Transcripts keep at most 600 characters, digit runs of 4+ redacted with the existing `redactDigits`.
- News lines, verbatim: `{Pro} left a voicemail: "{text}"`, `{Pro} called and left no message.`, `{Pro} left a voicemail that couldn't be transcribed. Call them back.`
- Alerts step ask, verbatim: `Want me to tell you the moment a pro texts or calls back? I'll set up an alert for this chat. You'll copy two values into secure cards.` Options: Yes, Not now.
- The alerts step and `save_repair_alerts` are Grok Bot only: Muse's Fixer Core task is polled hourly and can't be woken (`ASSISTANT_PROFILES[...].polledTask`).
- No new Railway variables. Run `bash scripts/ci-check.sh` green before the final commit.

## Review Focus

1. **A pro on two of the account's properties calls.** Expect the voicemail on the property with their live work (same rule as `fixerProText`), and the greeting names neither. Test in Task 6.
2. **Twilio sends the transcript callback twice, or before/after the recording callback.** Expect one news item per `RecordingSid`. Test in Task 6.
3. **The transcript says "yes", "stop", "done" or "$300".** Expect news only: no opt-in, no STOP, no job finished, no price raised. Test in Task 6.
4. **Cleaner Core is on at the property and the account also has a routine.** Expect the note through Cleaner Core only, and Fixer's outbox sends nothing (no double wake-up). Test in Task 3.
5. **An existing line pointed for SMS only before this ships.** Expect the startup pass to point voice once and not again on the next start. Test in Task 1.

---

### Task 1: Point each line's voice webhook

**Files:**
- Modify: `src/cleaner-core/hosted/twilioNumbers.ts` (replace `pointSmsWebhook`'s body params; add voice)
- Modify: `src/cleaner-core/hosted/lines.ts` (`pointLine`, `closeLine`, new `pointVoiceOnce`)
- Modify: `src/cleaner-core/hosted/numberPool.ts` (`voiceOk` beside `webhookOk`)
- Modify: the service startup where the hosted router is created (call `pointVoiceOnce(h)` once after start; find it with `grep -rn "hostedCleaner(" src`)
- Test: `test/lineVoicePointing.test.ts`

**Interfaces:**
- Produces: `VOICE_PATH = "/webhooks/twilio/voice"` and `VOICE_TRANSCRIPT_PATH = "/webhooks/twilio/voice/transcript"` exported from `src/hosted/voice.ts` (create the file with just these two constants here; Task 5 fills it).
- Produces: `pointLineWebhooks(env, numberSid, urls: { sms: string; voice: string }): Promise<boolean>` in `twilioNumbers.ts`; empty strings clear. Body: `SmsUrl`, `SmsMethod=POST`, `VoiceUrl`, `VoiceMethod=POST`, `VoiceApplicationSid=""`.
- Produces: `lineVoiceUrl(h): string` in `lines.ts`; `pointVoiceOnce(h): Promise<void>`.
- Produces: `NumberPool.setVoice(number: string, ok: boolean)`; `entry.voiceOk?: boolean`.

- [ ] **Step 1: Write the failing tests** in `test/lineVoicePointing.test.ts`:
  - `"points SMS and voice in one call and clears a TwiML App"`: stub fetch, call `attachTypedLine`; assert one POST whose form body has `SmsUrl=<origin>/webhooks/twilio/cleaner-core`, `VoiceUrl=<origin>/webhooks/twilio/voice`, `VoiceApplicationSid=` (empty).
  - `"closing a line clears both webhooks"`: `closeLine(h, tenant, "return")`; the POST has `SmsUrl=` and `VoiceUrl=` empty.
  - `"points an SMS-only line's voice once at startup, and not again"`: pool entry with `webhookOk: true` and no `voiceOk`; `pointVoiceOnce(h)` twice; exactly one Twilio POST; `voiceOk` true.
  - `"logs a refused voice pointing without the number"`: Twilio answers 400; log line contains `voice webhook` and no `+1555`.
- [ ] **Step 2: Run** `npx vitest run test/lineVoicePointing.test.ts` — Expected: FAIL (missing exports).
- [ ] **Step 3: Implement** the interfaces above. `pointLine` calls `pointLineWebhooks` with both URLs and records both `setWebhook` and `setVoice`. `pointSmsWebhook` stays as a thin wrapper only if other callers remain; otherwise remove it. The refusal log reads `Twilio didn't take a line's voice webhook. Point it again from the number pool on /admin.`
- [ ] **Step 4: Run** the test file and `npx vitest run test/` for the pool and admin tests — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Point each line's voice webhook with its SMS one"`

### Task 2: The agent's number in get_state

**Files:**
- Modify: `src/hosted/propertyTools.ts` (`accountState`, `GET_STATE.description`)
- Modify: `FIXER_CORE_BOOTSTRAP.md`, `muse-template/skills/fixer-core/SKILL.md`, `property-core-template/bot-profile.md`
- Test: `test/agentNumber.test.ts`

**Interfaces:**
- Produces: every `accountState` reply's `structured.agentNumber: string` (the tenant's `twilioNumber`, +1 form), at account level and per property, including the no-properties reply.

- [ ] **Step 1: Write the failing tests:** `"get_state carries agentNumber with no property, one, and several"` — three tenants built like the existing `accountState` tests; each reply's `structured.agentNumber` equals the tenant's 555 line.
- [ ] **Step 2: Run** it — Expected: FAIL.
- [ ] **Step 3: Implement.** Add `agentNumber` in `accountState` for every `done(...)` and the merged per-property reply. Description gains: `agentNumber is the account's text line: when the host asks for their agent's number, give it, and say their pros and cleaner text or call it, while the host talks to you in chat.` Add the same rule to the three guides (one bullet each).
- [ ] **Step 4: Run** the test and `npx vitest run test/propertyCoreReadme.test.ts test/fixerTemplate.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Give the host their agent's number from get_state"`

### Task 3: Fixer Core's alert outbox

**Files:**
- Modify: `src/alerts/operatorEvents.ts` (add `"repairs.update"` to `OPERATOR_EVENT_TYPES`; `repairsUpdateEvent(now: Date): OperatorEvent` like `cleaningUpdateEvent`)
- Modify: `src/fixer-core/desk.ts` (`FixerDeps`, `tell`, the outbox)
- Modify: `src/hosted/fixer.ts` (wire the deps)
- Test: `test/fixerAlerts.test.ts`

**Interfaces:**
- Produces: `FixerDeps.routine?(): { url: string; key: string } | undefined` — the account's routine for the primary connection, read on each delivery (never stored by the desk). Hosted reads `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY` from `ctx().env()`; `CLEANER_CORE_ENABLED=0` there (Cleaner Core off) doesn't matter, since only these two values are read.
- Produces: `FixerDeps.alertFetch?: typeof fetch` for tests.
- Produces: `FixerDesk.routineConnected(): boolean` (true when `deps.routine()` returns both values), and a private `wake(): void` that keeps at most one pending `repairs.update` and starts a drain. The outbox lives at `join(root, "fixer-alerts")` with `FileRuntimeStore` and a `GrokRoutineWebhookSink`.
- Behavior: in `tell`, when `deps.cleaningOn?.()` is true, notes go through `notifyHost` as today and `wake` is not called. When false, the note stays in news (unchanged) and `wake()` runs if `routineConnected()`.

- [ ] **Step 1: Write the failing tests** in `test/fixerAlerts.test.ts` (desk built like `test/fixerPeople.test.ts`'s `lineSetup`, with `routine: () => ({ url: "https://example.com/hook", key: "made-up-key-123" })` and a stub `alertFetch` that records requests):
  - `"wakes the routine with repairs.update holding only four fields"`: a pro's text on a Fixer-only desk; one POST; JSON keys exactly `["eventId","eventType","occurredAt","schemaVersion"]`; `eventType` `"repairs.update"`; body holds no `+1555` and no text words.
  - `"three notes make one pending wake-up"`: three texts with the stub fetch failing; one pending record.
  - `"with Cleaner Core on, notes go through Cleaner Core and nothing is sent"`: `cleaningOn: () => true`; `notifyHost` got the note; zero POSTs.
  - `"with no routine, the note waits in check_fixes news and nothing is sent"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces; `routine` returns `undefined` when either value is empty.
- [ ] **Step 4: Run** `npx vitest run test/fixer` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Wake the account's alerts routine from a Fixer-only property"`

### Task 4: The alerts setup step and save_repair_alerts

**Files:**
- Modify: `src/fixer-core/setupAsk.ts` (step `"alerts"`), `src/fixer-core/store.ts` (`setup.alertsDone?: true; setup.alertsSkipped?: true`), `src/fixer-core/desk.ts` (`saveSettings` takes `alertsSkipped`; new `issueAlertUpload`, `uploadAlerts`), `src/fixer-core/tools.ts` (tool `save_repair_alerts`, `alertsSkipped` on `save_fixer_settings`)
- Modify: `src/cleaner-core/hosted/router.ts` (`handleFixerOnlyPath`: the upload code route, saving through `ctx.saveSecrets`), `src/cleaner-core/hosted/router.ts` `promoteRoutineOwner` (count a Fixer-saved routine's connection)
- Create: `property-core-template/routines/property-core-alerts.md`
- Modify: `cleaner-template/routines/cleaner-core-alerts.md`, `FIXER_CORE_BOOTSTRAP.md`, `muse-template/skills/fixer-core/SKILL.md` (Muse: no alerts step), `test/fixerTemplate.test.ts`
- Test: `test/fixerDesk.test.ts`, `test/fixerHosted.test.ts`, `test/fixerTemplate.test.ts`

**Interfaces:**
- Consumes: `FixerDeps.routine`, `routineConnected()`, `wake()` from Task 3.
- Produces: `FixerDeps.assistant?(): CleanerAssistant`; the step shows only when `assistant() === "grok"`, `!routineConnected()`, and neither `alertsDone` nor `alertsSkipped`. Placed after upkeep, before review.
- Produces: tool `save_repair_alerts` (input `{}` strict) → `{ uploadUrl, expiresInMinutes, next }`. Reuse Cleaner Core's upload rules: one-time code, only its sha256 and expiry kept, `UPLOAD_MINUTES`, the same `routineRefused` checks (https only, key length ≥ 8, not masked, never the door-code key). Extract `routineRefused`'s pure checks into a shared function in `src/alerts/routineCheck.ts` rather than copying it. The upload saves `{ CLEANER_CORE_ROUTINE_URL, CLEANER_CORE_ROUTINE_KEY }` with `ctx.saveSecrets` (per connection), sets `alertsDone`, enqueues `testEvent`, and answers `{ ok: true }` with neither value.
- Routine doc: on `repairs.update` call `check_fixes` for each property with Fixer Core on and tell the host each news item once, urgent first; on `cleaning.update` call `check_now`; on `installation.test` post `Alerts are connected.`; never pause or edit itself.

- [ ] **Step 1: Write the failing tests:**
  - `fixerDesk.test.ts` `"asks for alerts after upkeep only on Grok with no routine, and not after Not now"`.
  - `fixerHosted.test.ts` `"save_repair_alerts gives a one-time link that saves both values for the connection and repeats neither"`: POST `{url:"https://example.com/hook", token:"made-up-key-123"}`; `h.secrets` holds them under the caller's connection; the response body and the tool reply contain neither string; a second POST to the same link gets 404.
  - `fixerHosted.test.ts` `"refuses an http address or a short key"`.
  - `fixerTemplate.test.ts`: `CHECK_FIXES_KEYS`-style check that both routine docs contain `repairs.update` and the bootstrap names `save_repair_alerts`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** per the interfaces and the Global Constraints wording.
- [ ] **Step 4: Run** `npx vitest run test/fixer test/cleaner` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Add the Fixer Core alerts step and save_repair_alerts"`

### Task 5: The voice webhook

**Files:**
- Modify: `src/hosted/voice.ts` (from Task 1)
- Modify: `src/cleaner-core/hosted/router.ts` (route `POST VOICE_PATH` like `CLEANER_TWILIO_PATH`: tenant by `To`; disabled or unknown → no-calls TwiML)
- Modify: `src/hosted/lineRouter.ts` (export `isLandlord`)
- Test: `test/voiceCall.test.ts`

**Interfaces:**
- Produces: `handleVoiceCall(h, r, tenant, rawBody, signedUrl): Promise<void>` — verifies the signature with `verifyTwilioSignature` (403 on failure), then answers TwiML.
- Produces: `knownCaller(tenant, people, from): "pro" | "person" | "landlord" | undefined` — `"landlord"` via `isLandlord`; `"pro"` via `proRoute`; `"person"` when `people.person(from)` has any `where` on the account's properties.
- Produces: `VoiceCalls` in `src/hosted/voiceCalls.ts`: `allow(from: string): boolean` (records the call when allowed; false at 5 in the last hour) over `<tenantFolder>/voice-calls.json` holding `sha256(phone)` → ISO times.
- TwiML is built with a small `twiml(parts)` helper that XML-escapes text; no user-supplied text goes into it.

- [ ] **Step 1: Write the failing tests** in `test/voiceCall.test.ts` (signature built with the test auth token like `test/sharedLineRouting.test.ts` does; find with `grep -ln twilioSignature test`):
  - `"refuses a forged call with 403"`.
  - `"an unknown caller hears the no-calls line and nothing is recorded"`: body has the exact no-calls text, no `<Record`.
  - `"the landlord hears the chat line and nothing is recorded"`.
  - `"a contacted pro hears the greeting and is recorded for up to 2 minutes with a transcript"`: exact greeting; `<Record maxLength="120"`, `transcribe="true"`, `transcribeCallback="<origin>/webhooks/twilio/voice/transcript"`.
  - `"the greeting names no address or business"`: property address `12 Scratch Lane` and a business name absent from the body.
  - `"a sixth call in an hour is not recorded"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `npx vitest run test/voiceCall.test.ts test/sharedLineRouting.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Answer calls on the line: voicemail for known callers only"`

### Task 6: The transcript into news

**Files:**
- Modify: `src/hosted/voice.ts` (`handleVoiceTranscript`), `src/cleaner-core/hosted/router.ts` (route `POST VOICE_TRANSCRIPT_PATH`)
- Modify: `src/fixer-core/desk.ts` (`proVoicemail`), `src/fixer-core/texts.ts` (the three news lines), `src/hosted/fixer.ts` (`fixerProVoicemail`, sharing `fixerProText`'s property pick)
- Test: `test/voiceTranscript.test.ts`, `test/fixerPeople.test.ts`

**Interfaces:**
- Consumes: `knownCaller` (Task 5), `wake` via `tell` (Task 3), `contactedJob` (existing).
- Produces: `FixerDesk.proVoicemail(input: { id: string; from: string; text: string; status: "completed" | "failed"; seconds?: number }): Promise<void>` — news kind `pro-voicemail` on the live visit's job, else `contactedJob`'s job, else file news; never reads a keyword; `urgent` when `isInjuryReport(text)`; text redacted and cut to 600 characters; empty text or `seconds < 2` gives the no-message line; `failed` gives the couldn't-transcribe line. Dedup by `id` through `seenInbound`.
- Produces: `handleVoiceTranscript(h, r, tenant, rawBody, signedUrl): Promise<void>` — 403 on a bad signature; reads `From`, `RecordingSid`, `RecordingDuration`, `TranscriptionStatus`, `TranscriptionText`; a pro → `fixerProVoicemail`; a person → that property's Cleaner Core `noteForHost(\`voicemail:${RecordingSid}\`, \`{Name} left a voicemail: "{text}"\`)` (Cleaner Core off there: log `A voicemail reached <tenant> for a property without Cleaner Core.`); then Task 7's delete. Always answers 200 empty.

- [ ] **Step 1: Write the failing tests:**
  - `voiceTranscript.test.ts` `"puts a contacted pro's voicemail on their job, by name"`.
  - `"a transcript of yes, stop, done or $300 changes nothing but news"`: people opt-in and stop state unchanged, job state and booking unchanged.
  - `"an injury voicemail is urgent"`; `"digits are redacted and the text is cut to 600"`.
  - `"empty or under 2 seconds says they left no message"`; `"failed says it couldn't be transcribed"`.
  - `"the same RecordingSid twice makes one news item"`.
  - `"a pro on two properties: the voicemail goes to the one with their live visit"`.
  - `"a cleaner's voicemail is a Cleaner Core note and nothing else"`.
  - `"refuses a forged transcript with 403"`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `npx vitest run test/voiceTranscript.test.ts test/fixer` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Turn a voicemail's transcript into news for the host"`

### Task 7: Delete the audio

**Files:**
- Modify: `src/cleaner-core/hosted/twilioNumbers.ts` (`deleteRecording(env, recordingSid): Promise<boolean>` — DELETE `/Accounts/{sid}/Recordings/{recordingSid}.json`; 404 counts as deleted)
- Create: `src/hosted/voiceDeletes.ts` (`VoiceDeletes` over `<tenantFolder>/voice-deletes.json`: `add(sid)`, `retry(env): Promise<void>` dropping a sid after success or 20 tries)
- Modify: `src/hosted/voice.ts` (delete after each transcript; `retry` on each voice callback), the startup from Task 1 (`retry` for each tenant)
- Test: `test/voiceTranscript.test.ts`

**Interfaces:**
- Consumes: `handleVoiceTranscript` (Task 6), startup hook (Task 1).

- [ ] **Step 1: Write the failing tests:** `"deletes the recording after the transcript, whatever its status"`; `"keeps a failed delete's sid and retries it on the next call, then forgets it"`; `"gives up after 20 tries"`; the file never holds a phone or text.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces.
- [ ] **Step 4: Run** `npx vitest run test/voiceTranscript.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Delete each voicemail's audio once it's transcribed"`

### Task 8: Gates, docs and the full check

**Files:**
- Modify: `docs/fixer-core-safety-gates.md` (rows **Alerts** and **Voicemail**, with the spec's text and the tests from Tasks 3–7 as proof, by exact test name), `docs/cleaner-core-safety-gates.md` (one line: a cleaner's or co-host's voicemail is a note for the host and nothing else, proof `test/voiceTranscript.test.ts` ("a cleaner's voicemail is a Cleaner Core note and nothing else")), `docs/environment-variables.md` (no new variables: one sentence that voice uses the line's existing Twilio account), `docs/hosted-multitenancy.md` (the two voice paths)
- Test: `test/fixerTemplate.test.ts` (its existing check that every gate-named test exists covers the new rows)

- [ ] **Step 1: Add the rows.**
- [ ] **Step 2: Run** `bash scripts/ci-check.sh` — Expected: exit 0, every step `ok`.
- [ ] **Step 3: Commit** `git commit -m "Name the alerts and voicemail gates"` and push `claude/ecstatic-einstein-mbyqqs`.
