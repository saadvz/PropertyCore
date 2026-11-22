# Locks and who comes in (#280 items 17, 19, 20, 21, 22)

Five findings from Saad's end-to-end test as a new host on Grok Bot with connected locks in the lock partner's
sandbox (21–22 Nov), plus one decision about the host's standing code. All of it is about who can open the door
and what the host hears about it.

| Item | What Saad saw | What changes |
| --- | --- | --- |
| 17 | An expected visit (#240) names nobody and gives no access, so the host would share their own code and any entry is "someone". | The visitor is a saved, opted-in person with their own code for that visit's window. Their entries are named. |
| 19 | Guest codes (#262) only see bookings from the booking-email log. A stay that comes only from the calendar never gets a code, and the bot just said "that's set". | Calendar stays get a code too, on the property's usual times. The host is told plainly which stays get one. |
| 20 | "Did anyone come in today?" got "the lock reported something at 1:13 AM but I can't see what it was". | A read-only door activity list: "The Front door was unlocked at 1:13 AM, without a code (from the app)." |
| 21 | After "disconnected, sign in again", nothing when the account came back. | One note when it's back, and the checkout-time code turned back on if the disconnect paused it. |
| 22 | Signing in again didn't bring the account back in the sandbox. Removing it and connecting fresh did, but the doors came back with new ids and the host had to pick them again. | Live codes move to the new doors with the same digits, on their own when the door names match. The bot guides the host through a stuck reconnect. |
| Host YES | AGENTS.md says the host never texts the Cleaner Core number, but the host's own standing code asks them to reply YES on it. | Open question 1 below. |

## Goals

- Everyone who gets in through Property Core has their own code, for their own window, and their entries carry
  their name.
- Every upcoming stay the property knows about can carry a guest code, and the host can see which ones will.
- The host can ask who came in and get a plain answer for every unlock, with or without a code.
- A lock account that drops and comes back never leaves a person without a working code, and never leaves the
  host guessing.

## Non-goals

- A manager's crew roster, the turnover check against a management agreement, and the manager's own hours log
  (still #240's later scope).
- Texting a guest. Guest codes still reach only the host, on the single-use page.
- New lock partners, or Seam's Access Grants. The adapter stays on access codes.
- Turning a feature switch on. Everything stays behind the existing switches on /admin.

## Anti-goals

- A code in a text to anyone but its own person, in a tool reply, a note or a log. The partner's `lock.unlocked`
  webhook carries a `code` field: the parser keeps never reading it.
- A text to a person before their own YES, or before the host's phone is confirmed.
- Any agent words widening who can be texted or who gets a code.

## Approaches considered

**Item 17, where the visitor's code comes from.**

1. *A new grant flow, `visit`, on #180's grants, the way bring-in (#241) and crew-day (#243) codes were built.*
   The oversight desk works out the codes it wants and calls `syncGrants("visit", wanted)`. **Picked.** It reuses
   issue, move, revoke, backups, the leak checks and the visit-log names, and it is the plan already written on
   #240.
2. *Make the visitor a pro and book a Fixer Core job.* Rejected: a walk-through isn't a repair, it would need
   Fixer Core on, and it would put a manager into the pro list and the hours log as a pro.
3. *Give the visitor a standing code.* Rejected: #240 asks for a code per visit, not a shared or standing one.

**Item 19, calendar stays.**

1. *Merge the calendar's stays into `guestStays`, with booking-email stays winning where both have the stay.*
   **Picked.** One list, one reconcile, one status.
2. *Only say which bookings can get a code.* Rejected as the whole fix: a host on Guesty Lite iCal alone would
   never get a guest code.

**Item 22, codes after the doors come back with new ids.**

1. *Move each live code to the new door with the same digits* (the grant keeps its sealed code, so the hub's
   existing retry puts the same value on the new door). **Picked.** Nobody has to be sent a new code.
2. *Revoke and re-issue.* Rejected: new digits for the cleaner, a pro, a guest's host page and every standing
   code, and a new text or link for each.

## Item 17: an expected visit with its own code

**Who the visitor is.** `add_expected_visit` takes an optional `phone` with `who`. With a phone:

- A person already saved on the property (cleaner, co-host, assistant, pro) who said YES and hasn't said STOP is
  used as they are.
- Anyone else is saved as a visitor ("someone the host expects at the property, like their manager") in the
  property's `oversight.json`, the way standing-code people and lease tenants are kept, and gets the one opt-in
  text under the account's texting consent, exactly like a pro: nothing else until their own YES; their STOP,
  account-wide on the people list, wins. A YES covers their later visits too. The visit can be saved before the
  YES; the code waits for it. (Builder's call: kept beside the visits rather than as a new role on the account's
  people list, so the line router and Cleaner Core's contacts are untouched; the visitor's YES is taken on the
  shared line like a standing-code person's.)
- Without a phone the visit works as today: checked, flagged, no code.

**The host's yes.** The read-back names the person and their code: "Mike Doyle, Thursday Nov 19, 12 to 5 PM,
with his own door code?" The host's yes to that read-back is the yes for the code (two calls, like every other
code). No separate approve step.

**The code.** Flow `visit`, code name prefix `Visit`, one grant per expected visit, job id the visit's id, for
the visitor's phone, named in `visit-codes.json` as a new role `{ role: "visitor" }`, with the visitor's name
in `EntryNames.codes` so the same-day check sees an entry by name (`whoMatches`).

- **Window:** the visit's window from 30 minutes before (like a pro's), or 8 AM to 8 PM for an all-day visit
  (the flag already runs at 8 PM). Cut around guest stays the way crew windows are (`crewWindows`): a window that
  falls inside a stay gets no code, and the host is told once that they'll need to let the person in.
- **Wanted** while the visit isn't cancelled, its window hasn't ended, the person said YES and no STOP, and the
  property is on connected locks. A cancel, a STOP or a different person revokes it. A moved visit (cancel and
  save again, as today) is a new grant.
- **Release:** one text with the code, 30 minutes before the window, through the consent-checked send path, like
  a bring-in code. The mark is saved before the send, so a restart never sends twice (an unsure send becomes a
  host note). Texts that can't go: one host note to let the person in another way. Backup code and saved-code
  fallbacks are the hub's, and the host is told each time, as for every flow.
- **When it runs:** on the lock clock (`tickAllLocks`), beside guest codes, so the code goes on the lock and the
  text goes without a tool call.

**Replies.** `list_expected_visits` shows each visit's person and `code`: `none` (no phone), `waiting-for-yes`,
`on-lock`, `texted`, `none-during-stay`, `failed`. Never digits.

## Item 19: guest codes for calendar stays

- `guestStays` adds every upcoming stay from `hub.stays()` (kind `stay`, never `block`) that no booking-email
  stay overlaps. Its key is `cal:<checkIn>:<checkout>`. Its window is the property's usual check-in and checkout
  times (else 4 PM and 11 AM), with a late checkout from guest messages as today.
- Where an email booking and a calendar stay overlap, the email's stay is used (it has its own times and
  reference). A calendar stay that already has a code when its email arrives keeps the code it has: the email
  booking takes over the calendar key's grant and page link instead of making a second code. (Builder: keep a
  small alias in `guest-codes.json` from the email key to the calendar key.)
- `get_guest_codes` lists each stay with `source: "email" | "calendar"`, and `next` says in one sentence which
  stays get a code: "Every booking from your calendar and booking emails gets one. Blocked dates don't."
- `guest_codes` replies say how many upcoming stays that covers, so the bot never says only "that's set".
- `make_guest_code` (ask mode) takes the calendar key as its `stay`. The status's `stay` field already gives it.

## Item 20: who came in, with or without a code

The unlock is stored today: `recordLockEvent` writes it as a `lock` line with `method`, and no code name when
there was no code. Nothing the bot can call lists those lines; `visit_health` gives only the last one's time.

- A new read-only tool, `door_activity` (from and to local dates, at most 7 days, default today), lists each
  unlock and lock in the property's time zone: the door, whose code it was (by the visit log's code names: the
  cleaner, a pro, the host's own code, a guest's code, a visitor, a package helper), or "without a code" with how
  in plain words from the partner's method (`remote` and `mobile_key`: "from the app"; `manual`: "by hand or with
  a key"; `automatic`: "on its own"; `card`: "with a card"; `unknown`: no words). A keypad code nobody named is
  "with a code that isn't one of Property Core's". It sends nothing.
- Its `next` gives the bot one sentence per entry, like "The Front door was unlocked at 1:13 AM, without a code
  (from the app)."
- `visit_health` says to use `door_activity` for who came in.
- The Seam parser keeps `method` for every unlock (it does), and its `side: "outside"` rule is unchanged.

## Item 21: a note when the lock account is back

- On `account-connected` (Seam's `connected_account.connected`, which fires on a reconnect) after a disconnect
  note was told, one note: "Your lock account is connected again, so codes can be made and changed."
- If the disconnect turned the checkout-time code off (`release.cleaners` was `automatic`), it's turned back on
  and the note says so. A first connect gets no note. Keyed once per disconnect.
- `connected_account.completed_first_sync_after_reconnection` maps to a new event kind, `account-synced`, which
  runs item 22's door check.

## Item 22: recovery when the doors come back with new ids

**The door check.** On `account-synced`, on the lock clock while a disconnect is unresolved, and on `get_locks`,
the desk compares the saved doors with the devices the partner lists now.

- **Every saved door is still there:** nothing to do.
- **A saved door is gone, and exactly one new lock in the account has the same name (case and spacing
  ignored):** the door is re-homed on its own. The saved device id changes, every live grant on it (cleaning,
  repair, standing, guest, bring-in, visit) gets the new door with no code id, and the hub's retry puts the same
  digits on it. The host gets one note: "Your locks came back after the reconnect. Everyone's codes were put
  back on the Front door, so nobody needs a new one." A door that refuses the old digits gets a backup code or
  the host's note, as today.
- **A saved door is gone and no single lock matches:** the property keeps its saved door code (as with a mixed
  door), and the host gets one urgent note to pick the doors again. `save_locks` with the new ids then re-homes
  the live codes the same way.

**A stuck reconnect.** `get_locks` reports `account: "disconnected"` when the partner still lists the account
with its `account_disconnected` error (the adapter's `accounts` gains a `disconnected` flag). `next` walks the
bot through it: first a fresh sign-in link; if the account still shows disconnected after the host signed in,
`connect_lock` with `fresh: true` (the host's two-call yes) removes the stuck connection at the partner and gives
a new link. The door check then re-homes the codes when the doors come back.

**Codes left on the old devices.** The partner can't remove a code through a device id it no longer has. A
time-bound code ends on its own. A standing code has no end, so after a re-home the host is told once to check
the lock's own app for codes named "Standing …" left from before and remove them.

## The host's standing code and the YES (open question 1)

Today the host's own standing code texts the host's confirmed phone "Reply YES", which asks the host to text the
Cleaner Core number. The host's phone was already confirmed with a code at sign-up, and the host just said yes in
chat, so the reply adds nothing. Recommended: for role `owner` on the confirmed phone on file, skip the invite and
the YES, and text the single-use link straight away. A co-owner's or co-host's code, and an owner code on a
typed number, still ask for YES. AGENTS.md stays as it is.

## Open questions for Saad

1. **The host's own standing code: skip the YES or allow the one exception?** Recommended: skip the YES for the
   host's own confirmed phone and send the link at once. The rule in AGENTS.md stays absolute, and there's one
   step fewer.
2. **The visitor's code: a text with the code, or a single-use link?** Recommended: one text with the code 30
   minutes before the window, like a cleaner's, a pro's and a bring-in helper's. A link is for long-lived codes.
3. **The visitor: a new `visitor` person saved with the visit, or only people already saved as co-host or
   assistant?** Recommended: a new `visitor` role saved from `add_expected_visit`, with the usual one opt-in
   text. Saving a co-host needs Cleaner Core and uses one of its four contact places.
4. **Is the host's yes to the visit's read-back the yes for the code?** Recommended: yes. The read-back names the
   person and says they get their own code. No second approval.
5. **Calendar-only stays: give them guest codes the same way?** Recommended: yes, on the property's usual times,
   and never for blocked dates.
6. **Re-home codes on their own when the new doors have the same names?** Recommended: yes, keeping everyone's
   digits, and ask the host only when the names don't match.
7. **Turn the checkout-time code back on by itself when the account reconnects?** Recommended: yes, since only
   the disconnect turned it off, and the note says so.

## My calls (the builder can rely on these)

- All-day visit codes run 8 AM to 8 PM. A visit code never runs inside a guest stay.
- The `visit` flow isn't on `release.pros`; the host's yes to the visit stands in for it.
- `door_activity` reads at most 7 days at a time and needs the account's locks on.
- The re-home note and the leftover-standing-code note are each told once per reconnect.
- Calendar keys are `cal:<checkIn>:<checkout>`, letters and dates only, never a guest's name.

## Safety gates

New and changed rows, each with its tests, in `docs/cleaner-core-safety-gates.md` (Connected locks, Guest codes,
Standing codes) and `docs/fixer-core-safety-gates.md` where Fixer's door access is touched:

- Visitor codes: no code before the visitor's YES and the host's yes; the code only to the visitor's own phone;
  never during a stay; STOP or a cancel removes it; a replay sends nothing twice.
- Guest codes: calendar stays, never blocks; one code per stay when an email arrives later.
- Door activity: read-only, no digits, no phone; the `code` field of the partner's webhook is never read.
- Reconnect: re-homed codes keep their digits and go only to the same people; no code is shown to anyone in the
  re-home; a door with no match falls back to the saved door code.
- Standing codes: the host's own code skips the YES only on the confirmed phone on file (if question 1 goes
  that way).

## Testing

Test-first, with the in-memory fake lock adapter (`src/locks/fake.ts`), which gains: replacing a device with a
new id (same name), a disconnected account flag, and deleting a connection. 555 numbers and made-up codes only.
Nothing reaches the lock partner or a real phone.

## Grok retest (summary; full steps go in the PR)

After merge, on the test property: an expected visit with the manager's (test) phone and a code; a calendar-only
stay's guest code; "Did anyone come in today?" after an app unlock in the sandbox; a forced disconnect, then a
reconnect, with the note and the codes back on the doors.
