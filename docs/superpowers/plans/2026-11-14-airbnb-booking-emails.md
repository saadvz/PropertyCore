# Booking details from Airbnb emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The host's agent passes each Airbnb reservation email to Property Core, which reads its times, guest count and confirmation code and applies them to the matching cleanings.

**Architecture:** A pure parser and an append-only log live in `src/hub/` (no Cleaner Core imports). Cleaner Core's engine gains two narrow methods (`setJobTimes`, `callOffJob`); its desk gains the `read_booking_email` tool that matches the property and stay, applies times, and asks the host when the email and the calendar disagree. The shared service routes an email with no `property` to the one property whose listing matches.

**Tech Stack:** TypeScript, Node 22, vitest, zod (MCP schemas).

**Spec:** `docs/superpowers/specs/2026-11-14-airbnb-booking-emails-design.md`

## Global Constraints

- Tests use only made-up emails, made-up `HM` codes, made-up door codes, and 555 numbers.
- `src/hub/` imports nothing from `src/cleaner-core/` or `src/supply-core/` (`test/hubBoundaries.test.ts`).
- Only a sender at `airbnb.com` (or a subdomain) is read.
- An email never adds or removes a booked night; the calendar decides.
- The log and every reply never hold a door code.
- The smart-lock step is a do-nothing hook (`StayCodeHook`), waiting on #180.
- Pending emails turn into a host note after 3 hours (`PENDING_MS = 3 * 60 * 60 * 1000`).

## Review Focus

- A forwarded email (`Fwd:` subject, `From:` of the host) is refused as not from Airbnb; test in Task 1.
- An email read twice (agent retries) changes nothing the second time; test in Task 2 and Task 4.
- A December email about a January stay gets next year; test in Task 1.
- An email time equal to the saved time adds no host note; test in Task 4.
- A change email for a job whose code already went out leaves the job alone and notes the host; test in Task 4.

---

### Task 1: Parser and redaction

**Files:**
- Create: `src/hub/airbnbEmail.ts`
- Create: `test/fixtures/airbnb-emails/{confirmed-stacked,confirmed-columns,changed,cancelled-range,cancelled-bare,guest-message,door-code}.txt` (first line `From:`, second `Subject:`, blank line, body)
- Test: `test/airbnbEmail.test.ts`

**Interfaces:**
- Produces:
  - `interface BookingEmailInput { from: string; subject: string; body: string; messageId?: string; receivedAt?: string }`
  - `interface ParsedBookingEmail { kind: "confirmed" | "changed" | "cancelled"; confirmationCode: string; listing?: string; checkIn?: { date: string; time?: string }; checkout?: { date: string; time?: string }; guests?: { adults: number; children: number; infants: number; total: number } }`
  - `type ParseRefusal = "not-airbnb" | "not-a-reservation" | "no-code" | "no-dates"`
  - `parseAirbnbEmail(email: BookingEmailInput, now: Date): { ok: true; parsed: ParsedBookingEmail } | { ok: false; reason: ParseRefusal }`
  - `redactBookingEmail(body: string, carriesCode?: (text: string) => boolean, code?: string): string`
  - `normalizeListing(text: string): string`

- [ ] Write tests: each fixture parses to its exact fields; `Fwd:` from the host → `not-airbnb`; guest message → `not-a-reservation`; Dec 28 email about "Jan 3" → next year; redaction removes `6907` from "Lockbox code: 6907" and keeps `HMXK4Q2Z9R`.
- [ ] Run, see them fail; implement; run, see them pass.

### Task 2: The log

**Files:**
- Create: `src/hub/bookingEmails.ts`
- Modify: `src/cleaner-core/hosted/migrate.ts` (`PROPERTY_FILES` gains `booking-emails.jsonl`)
- Test: `test/bookingEmailLog.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `BOOKING_EMAILS_FILE = "booking-emails.jsonl"`
  - `interface BookingEmailRecord { at; receivedAt; messageId?; from; subject; body; parsed?: ParsedBookingEmail; refused?: string; outcome: BookingEmailOutcome }`
  - `type BookingEmailOutcome = "applied" | "pending" | "mismatch" | "disagrees" | "refused" | "duplicate" | "asked" | "called-off"`
  - `readBookingEmails(root): BookingEmailRecord[]`, `appendBookingEmail(root, record): void`, `isDuplicate(records, email): boolean`
  - `interface EmailBooking { confirmationCode; listing?; checkIn: string; checkout: string; checkInTime?; checkoutTime?; guests?: number; guestBreakdown?; cancelled: boolean; lastAt: string }`
  - `rebuildBookings(records): Map<string, EmailBooking>` (only `applied`/`pending`/`called-off` records count; a cancellation sets `cancelled`)
  - `interface EmailStay { checkIn; checkout; checkInTime?; checkoutTime?; guests?; confirmationCode }`, `stayForNight(root, date): EmailStay | undefined`

- [ ] Tests: two appends read back in order; a duplicate by message id and by content; rebuild applies a change over a confirmation and drops a cancelled stay from `stayForNight`; `stayForNight` covers check-in night, not checkout night.
- [ ] Fail, implement, pass.

### Task 3: Engine methods

**Files:**
- Modify: `src/cleaner-core/core.ts` (`CleanerCore` interface, `JobView.checkInDate?`, implementation)
- Test: `test/cleanerJobTimes.test.ts`

**Interfaces:**
- Produces:
  - `setJobTimes(input: { jobId: string; checkout?: number; checkIn?: number }): Promise<{ applied: boolean; reason?: "unknown" | "closed" | "code-sent"; sent: CleanerText[] }>` — minutes since midnight; adds facts and drains like `setHostTimes`; refuses canceled, declined, started, done, or a job whose code was delivered.
  - `callOffJob(jobId: string): Promise<CleanerText[]>` — the same call-off as `hostStandDown` does for one job.
  - `JobView.checkInDate?: string`

- [ ] Tests (engine on the Scratch Lane feed): `setJobTimes` on a fresh job makes the offer carry the time; on an offered job sends the existing update; on a done job is refused with `closed`; `callOffJob` on an offered job sends the existing cancel text once and the next poll doesn't reopen it.
- [ ] Fail, implement, pass.

### Task 4: The desk tool

**Files:**
- Modify: `src/hub/store.ts` (`HubProperty.listings?: string[]`), `src/hub/hub.ts` (save it), `src/cleaner-core/liveDesk.ts` (`saveProperty` takes `airbnbListings`, `readBookingEmail`, pending retry after each calendar read, notes, `guests`/`confirmationCode` on job views, `setStayCodeHook`), `src/cleaner-core/mcp.ts` (tool + `save_property` field + one instruction line), `src/cleaner-core/assistant.ts` (the same instruction line for each assistant, if the instruction list is per assistant)
- Create: `src/cleaner-core/stayCodeHook.ts` (`StayCodeHook`, `noStayCodeHook`)
- Test: `test/bookingEmails.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `LiveDesk.readBookingEmail(input: { email: BookingEmailInput; googleEvents?: GoogleEventList; confirmation?: string }): Promise<ToolReply>` with `result.outcome` one of the outcomes above; `setStayCodeHook(hook | undefined)`.

- [ ] Tests (desk harness, CALENDAR_ICS stays a Oct 14–18 and b Oct 18–22): confirmation for stay b sets job a's check-in and job b's checkout; mismatch listing → note, nothing changes; dates disagree → note; same-day booking not in the calendar yet applies after the calendar read inside the tool; pending after 3 hours becomes a note on `check_now`; email time ≠ saved → one note, equal → none; change after the code went out → left alone, note; cancellation the calendar removed → `applied`, no ask; cancellation the calendar still shows → ask with code, yes calls it off with the cancel text, hook called; duplicate → `duplicate`; nothing in the log or replies holds `8088`.
- [ ] Fail, implement, pass.

### Task 5: Shared service routing

**Files:**
- Modify: `src/hosted/frontMcp.ts`
- Test: `test/bookingEmailsHosted.test.ts`

- [ ] Tests (multi-tenant harness, two properties): an email with no `property` whose listing matches one property's saved listing goes to that desk; one that matches none, or both, is refused with "Which property?" naming labels and stores nothing.
- [ ] Fail, implement, pass.

### Task 6: Docs and gates

- [ ] `docs/cleaner-core-safety-gates.md`: the **Booking emails** row.
- [ ] Run `npm run typecheck`, `npm test`, `bash scripts/ci-check.sh`.
