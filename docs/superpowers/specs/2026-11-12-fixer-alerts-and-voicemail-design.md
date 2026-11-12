# Fixer Core alerts without Cleaner Core, voicemail on the line, and the agent's number

Status: design approved in chat on 2026-11-12. Waiting for the written spec review.

## Why

A pro that Grok calls for a quote often asks for a number to reach back. `contact_pro` now gives the
account's text line as `callbackNumber` (commit d911fb7), and a contacted pro's text becomes news on their job.
Three gaps remain:

1. On a property with only Fixer Core on, that news waits for the hourly Fixer Core Check. Only Cleaner
   Core's setup creates the alerts routine that wakes Grok at once.
2. A pro who calls the line instead of texting reaches nothing: the service has no voice handling.
3. The host can't ask Grok for the number their agent uses.

Success: on a Fixer-only property, a pro texts or calls the line and the host hears about it from Grok
within a minute; and the host can ask "what's my agent's number?" and get it.

## Decisions

| Question | Decision |
| --- | --- |
| How a Fixer-only property alerts the host | Wake Grok through the account's alerts routine (A1). No text to the host's phone. |
| Who can leave a voicemail | Known callers only: a pro contacted on an open job, a saved pro, or someone saved on a property (cleaner, co-host, assistant, observer). |
| Transcription | Twilio's built-in transcription on `<Record>`: English, up to 2 minutes. No new vendor or key. |
| The audio | Deleted at Twilio once the transcript arrives. Only the transcript is kept. |
| Rejected | Moving alerts out of Cleaner Core into an account service (A2: too large, touches Cleaner Core's gates); a hidden Cleaner Core desk for alerts (A3); forwarding calls to the host (B2). |

## Part A: alerts without Cleaner Core

### What exists

- The alerts routine's webhook address and key are saved per account, per Grok connection
  (`saveSecrets` puts `CLEANER_CORE_ROUTINE_URL` and `CLEANER_CORE_ROUTINE_KEY` under the connection), and
  `buildTenantEnv` gives each property the primary connection's pair.
- Cleaner Core's desk wakes the routine through an `OperatorEventOutbox` with a `cleaning.update` event.
  Fixer Core's `notifyHost` reaches the host only through that desk, so with Cleaner Core off at the
  property a note waits in `check_fixes`' news.

### Design

- **Fixer Core's own outbox.** The Fixer desk gets an `OperatorEventOutbox` in its property folder. Its
  event is `{ schemaVersion: 1, eventId, eventType: "repairs.update", occurredAt }`: nothing else, no
  names, phones, or message text. It sends to the account's routine address and key read from the
  property's environment, retries like Cleaner Core's, and keeps at most one pending `repairs.update`, so
  several notes in a row make one wake-up.
- **Which path a note takes.** With Cleaner Core on at the property, `notifyHost` goes through Cleaner Core
  as today, and the Fixer outbox sends nothing. With it off, the note stays in `check_fixes`' news (as
  today) and the Fixer outbox queues a wake-up when the account has a connected routine.
- **Is a routine connected.** True when the property's environment holds both routine values for the
  primary connection. A new hosted helper answers it for any property of the account.
- **Setup step `alerts`.** In `fixerSetupAsk`, after upkeep and before review, only while no routine is
  connected on the account. The ask: "Want me to tell you the moment a pro texts or calls back? I'll set
  up an alert for this chat. You'll copy two values into secure cards." Options: Yes, Not now.
  - Yes: Grok creates the **Property Core Alerts** routine from
    `property-core-template/routines/property-core-alerts.md`, then sends the host one link to the
    routine's Webhook URL field and one to its Webhook key field, with a secure card for each, the address
    first, exactly as Cleaner Core's `ROUTINE_ASK` says. Then it calls `save_repair_alerts` with no
    arguments, which gives a one-time upload link, and POSTs `{"url", "token"}` to it from its own cloud
    computer. The upload saves them through the same `saveSecrets` (per connection), queues a test event,
    and marks the step done. Its reply never repeats either value.
  - Not now: `save_fixer_settings` with `alertsSkipped: true`. Notes wait for the hourly check.
- **Routine docs.** The new `property-core-alerts.md` handles `cleaning.update` (call `check_now`, as
  Cleaner Core Alerts does), `repairs.update` (call `check_fixes`, tell the host each news item once,
  urgent first), and `installation.test`. The existing `cleaner-template/routines/cleaner-core-alerts.md`
  gains the `repairs.update` line, so an account with Cleaner Core's routine needs no new cards.
- **Primary chat.** `promoteRoutineOwner` also counts a routine saved through `save_repair_alerts`, so the
  chat that saved it becomes primary when the current primary has none.

## Part B: voicemail on the line

### Pointing the number

- `pointLine` (in `src/cleaner-core/hosted/lines.ts`) sets the number's `SmsUrl`, `VoiceUrl` (the new
  voice webhook, POST) and an empty `VoiceApplicationSid` in the one Twilio API call, so a TwiML App or
  Studio flow set in the console no longer takes the calls. `closeLine` clears `SmsUrl` and `VoiceUrl`.
- The pool records the voice pointing beside the SMS one. At startup, each assigned line whose voice
  isn't pointed is pointed once; a refusal is logged ("Twilio didn't take a line's voice webhook...").
  The `/admin` "point it again" button sets both.
- No new Railway variables. Recording and transcription bill on the same Twilio account.

### The call

1. **Voice webhook** `POST /webhooks/twilio/voice`. Twilio's signature is checked as for texts; a forged
   request gets 403 and nothing else. The `To` number picks the account; an unknown `To` gets the
   no-calls reply.
2. **Who's calling** (`From`):

   | Caller | Reply (TwiML) | Recorded |
   | --- | --- | --- |
   | A pro on the line (`proRoute`: contacted on an open job, booked, or saved) | greeting, then `<Record>` | yes |
   | Saved on one of the account's properties in another role | greeting, then `<Record>` | yes |
   | The landlord (`isLandlord`) | "This line is for your pros and cleaner. Talk to your assistant in chat." then hang up | no |
   | A known caller with 5 recordings in the last hour | the no-calls reply | no |
   | Anyone else | "This number doesn't take calls. Please text it." then hang up | no |

3. **Greeting:** "Hi, you've reached the repairs and cleaning line. This call is recorded. Please leave
   your message after the tone, then hang up." No address, no business name, no property label.
4. **Record:** `<Record maxLength="120" timeout="5" playBeep="true" transcribe="true"
   transcribeCallback="<origin>/webhooks/twilio/voice/transcript">`. Nothing after it but a hang up.
5. **Transcript callback** `POST /webhooks/twilio/voice/transcript`, signature checked. It carries the
   call's `From`/`To`, `RecordingSid`, `TranscriptionStatus` and `TranscriptionText`. Twilio may send it
   twice: a handled `RecordingSid` is ignored the second time.
6. **Where it goes:**
   - A pro: the Fixer desk's new `proVoicemail({ id, from, text, status })`, on the property `fixerProText`
     would pick. News on the job `contactedJob` or the live visit names, else file news, kind
     `pro-voicemail`: `{Pro} left a voicemail: "{text}"`. It never reads a keyword: "yes", "stop", "done" or
     a price in a voicemail opt in, stop, finish or raise nothing. An injury phrase marks it urgent. Then
     the note goes out by Part A's path.
   - Another role: the Cleaner Core desk's `noteForHost` on that property: `{Name} left a voicemail:
     "{text}"`. With Cleaner Core off there, it is dropped with a log line naming no one.
   - Digit runs of 4 or more are redacted, as for texts. At most 600 characters are kept.
7. **Edge cases:**
   - `TranscriptionStatus` `completed` with empty text, or a recording under 2 seconds: `{Pro} called and
     left no message.`
   - `failed`: `{Pro} left a voicemail that couldn't be transcribed. Call them back.`
   - The service down during the call: Twilio plays its own error; nothing is kept.
8. **The audio.** After the transcript is handled (any status), the service calls Twilio's DELETE on the
   recording. A failed delete keeps only the `RecordingSid` in a small account list
   (`voice-deletes.json`), retried on each later voice callback and at startup, at most 20 tries.
9. **Rate limit.** Recordings per caller per account in the last hour, kept in memory and in the account
   folder (`voice-calls.json`, phone hash and times only).

## Part C: the agent's number

- `get_state` (account level and per property) always carries `agentNumber`: the account's line in +1
  form.
- The guides (Grok bootstrap, Muse skill, `property-core-template/bot-profile.md`) say: when the host asks
  for their agent's number, give `agentNumber`, and say it's the number their pros and cleaner text or
  call; the host talks to you in chat, and a text from the host to it isn't used.

## Safety gates

`docs/fixer-core-safety-gates.md` gains two rows; `docs/cleaner-core-safety-gates.md` gains one line.

| Gate | What it holds |
| --- | --- |
| Alerts | The `repairs.update` payload is the four fields only. The routine's address and key are saved per connection, never returned in a tool reply, never logged, never in a file in the repo. |
| Voicemail | Only known callers are recorded, after a greeting that says the call is recorded and names no address or business. At most 5 recordings per caller an hour, 2 minutes each. The audio is deleted after the transcript. A transcript is news only: it never opts anyone in or out, approves, books, finishes a job, or sets a price. Forged voice webhooks are refused. |
| (Cleaner Core) | A cleaner's or co-host's voicemail is a note for the host and nothing else. |

## Tests

Twilio is stubbed, phones are 555 numbers, and nothing reaches a real phone.

- **Setup:** the `alerts` step appears only with no routine on the account, and not after Not now; the
  upload saves both values for the connection and the reply holds neither; a test event is queued.
- **Outbox:** a `repairs.update` holds exactly the four fields; three notes make one pending wake-up;
  with Cleaner Core on, Fixer's outbox sends nothing.
- **Voice webhook:** forged signature 403; unknown caller and landlord get no `<Record>`; a contacted pro
  gets `<Record maxLength="120" transcribe="true">`; the greeting holds no address or business; the 6th
  call in an hour has no `<Record>`.
- **Transcript:** news on the right job under the pro's name; "yes", "stop", "done" and "$300" change
  nothing; an injury is urgent; digits redacted; empty gives "left no message"; failed gives "couldn't be
  transcribed"; a repeated `RecordingSid` is ignored; DELETE is called, and a failed DELETE is retried.
- **Pointing:** `pointLine` sends `SmsUrl`, `VoiceUrl` and an empty `VoiceApplicationSid`; `closeLine`
  clears both URLs; the startup pass points an unpointed line once.
- **Agent number:** `get_state` carries `agentNumber`, at account level and per property.
- **Templates:** the guides name the `alerts` step, `save_repair_alerts` and `agentNumber`; both routine
  docs handle `repairs.update`; the gate rows' named tests exist.

## Out of scope

- Texting the host's phone for an alert.
- Calls from unknown numbers, languages other than English, messages over 2 minutes.
- Playing the audio back to the host.
- Moving Cleaner Core's alerts to an account-level service.
