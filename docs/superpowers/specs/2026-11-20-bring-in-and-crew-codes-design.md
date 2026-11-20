# Bring-in codes and crew-day codes (#241, #243)

Two more flows on #180's grants, following the guest-codes pattern (#262): a flow works out which codes it
wants, `syncGrants(flow, wanted)` issues, moves and revokes them, and each code is named in `visit-codes.json`.

## Decisions (Saad, 20 Nov)

| Question | Answer |
| --- | --- |
| Crew: a code per crew member, or per crew? | **One per crew**, for the booked pro (the crew lead), who lets the crew in. No crew roster. |
| Crew: same code each workday, or new digits daily? | **Same code, moved daily.** One grant, live only in the current or next workday window; after a window ends, the next sync moves it to the next one. |
| Bring-in: how does the person get the code? | **A text with the code**, like a cleaner's or a pro's: one text, through the consent-checked send path. |
| Bring-in: which "how codes go out" setting? | **Its own**, `release.packages`, `ask` (default) or `automatic`, beside `cleaners` and `pros`. Unset reads as ask. |

## Rules that hold for both

- Only on a property on connected locks (`DoorAccess.connected()`: `SMART_LOCKS`, an adapter, the host's
  switch-on, every door connected). Otherwise nothing reaches a lock and every reply is exactly as before.
- Behind the existing flags: `PACKAGE_ARRIVALS` for bring-in, `FIXER_CORE` for crews, `SMART_LOCKS` for both.
- No window past the next check-in buffer: the bring-in window is cut at the next busy time (check-in minus
  the buffer); crew windows are already cut around stays by `crewWindows`. No extensions for either.
- Leak checks: both are grants, so `codesForChecks` holds them until a day after the window, like every other.
- Named in `visit-codes.json`: a crew's code as `{ role: "pro", proId }` (the booked pro, as today); a bring-in
  code under a new, additive role `{ role: "package" }`. Not `cleaner`: the visit records would read a
  cleaner's bring-in unlock as a cleaner's stray entry. Not unnamed or `shared`: "someone else came in" would
  fire. Older readers that don't know `package` drop the entry, as they do any unknown role.

## Bring-in code (#241)

- **Flow** `bring-in`, code name prefix `Package`. One grant per delivery, job id `supply:<orderId>`, for the
  person the host picked (their phone).
- **Wanted** when: the delivery has a bring-in visit, isn't marked inside, the drop is seen, the person can
  still be picked (saved, YES, no STOP), and the window is still open. **Window:** from the later of the drop
  and the planning, to the deadline (drop plus the host's hours), cut at the next check-in buffer. A window
  that starts during a stay or its buffer gets no code; the visit shows `code: "none-during-stay"`.
- **Ended** when the package is marked inside (the next sync wants nothing for it), the host picks someone
  else (person changes, the old code is revoked), or the person says STOP.
- **Release.** `release.packages` = `ask`: the code is on the lock but the text waits for the host's OK through
  `approve_bring_in_code` (two calls: a question and an approval code, then the code). `automatic`: the text
  goes on the first sync with the code live. Either way, at most one text per visit; the mark is saved before
  the send, so a restart never sends twice (an unsure send becomes a host note). The release uses the hub's
  fallbacks: a backup code for a door that failed, then the host's saved code, else nothing, and the host is
  told each time.
- **Texts can't go** (the host isn't confirmed, or texts are off): one host note to tell the person the way in.
- **When it runs.** Package arrivals has no clock. The hosted package call runs `syncCodes()` after every
  package tool (`check_packages` runs in the Supply Core Check routine), and the lock enforces the window on
  its own. The tool reply gains `lockNotes` for the host.
- **Replies.** Off connected locks, every reply is unchanged (`code: "waiting"`, `CODE_WAITING`). On connected
  locks, `code` reads `on-lock` / `waiting-for-ok` / `texted`, and `next` says what the host does.

## Crew-day codes (#243)

- **Access.** On connected locks a crew job may be booked with `access: "code"`; off them, the host still lets
  the crew in (`CREW_HOST_ACCESS`, unchanged).
- **Wanted:** in the existing `repair` flow, one grant per crew job, for the booked pro's phone, job id the job's
  id, window = the workday window open now (from 30 minutes before) or else the next one, from
  `crewWindows` around the current stays. When none is left, nothing is wanted and the code is revoked.
- **Moves daily.** When today's window ends, the next sync moves the same grant to the next workday window.
  Between windows the lock refuses the code. A moved grant keeps its value, so the crew learns it once.
- **Release** follows `release.pros`: under ask, the host OKs once for the whole job (`approve_code`, as today);
  the pro gets the code on the visit page at the door, or one text on the text path, as for any pro. The
  release only runs inside a workday window: outside one, the page says it's outside the crew's hours.
- **No extensions** for a crew (as today).

## Gate rows

New rows go in `docs/cleaner-core-safety-gates.md` (a "Bring-in codes (#241)" section) and
`docs/fixer-core-safety-gates.md` ("Crew-day codes (#243)"), each with its tests.

## Person-facing text, for the wording pass

- The bring-in code text to the person.
- Host notes: texts can't go, the text may not have gone, the code was texted, no code during a stay.
- The `approve_bring_in_code` question.
- The crew code text's line about workdays and hours, and the "outside the crew's hours" page state.
