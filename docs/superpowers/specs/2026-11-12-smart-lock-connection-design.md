# Smart-lock connection

Status: design agreed in chat with Saad on 2026-11-12. Waiting for review of this written spec.
Project 1 of 8 on the Property Core build map (https://claude.ai/artifact/3LNYxEX56qRtv1pdxHJvry).
Follows `docs/superpowers/specs/2026-11-07-property-hub-door-access-design.md`, which left a slot for
"a lock partner (#180)".

## Why

Property Core arranges the work at a rental. Saad decided to grow it into proving the work happened:
who came through which door, when, for how long, and for which job. That record is what Cory Sorice,
our first tester and an Airbnb host with two houses, keeps by hand for his taxes (his 20 host stories,
5 Oct 2026, and the Porter v0 brief, 11 Nov 2026).

Every later project rests on one thing Property Core doesn't have: a lock that issues a code per
person per visit and reports back who opened it. Today each property has one saved code, the host's
own, and every cleaner and pro gets that same code.

This project connects a host's smart locks through Seam so that:

- each cleaner and pro gets their own code, live only for their visit;
- the lock's events (unlocks, low battery, a code that failed to program) come back and are kept;
- a host can choose to have the cleaner's code sent at checkout time without confirming the guests left.

Success: at a test property on a Seam sandbox lock, a cleaner's turnover and a pro's visit each run
end to end with their own code, issued ahead, released on time and removed after, every unlock is
stored with the code that opened it, and a failed code falls back without anyone being locked out.
A property with no connected lock behaves exactly as before.

## Who it's for

Any host on Property Core, on any property, with any lock Seam supports. Cory's two houses
(Adélie Cottage, a Yale lock; Holiday Chalet, lock model to confirm) are our own test sites, not the
target. Nothing in this design is specific to them.

## Goals

1. A host connects their lock account from setup, through Seam's own sign-in page.
2. Each cleaning and each Fixer visit gets its own code, created when the visit is booked, on every
   connected lock the person needs, live only for the visit's window.
3. Release hands over the code already on the lock. A code that failed to program falls back to a
   backup code, and the host is told.
4. The code changes when the visit's window changes and is removed when the visit is cancelled,
   declined or paused.
5. Every lock event is stored as received, append-only, per property.
6. The host hears, in their agent chat, about a low battery, a lock gone offline, a lock account
   disconnected, a code that failed to program, and an empty backup pool.
7. A host with a connected lock can turn on "send the cleaner's code at checkout time" per property.
8. Standing codes for the host and people the host names (a co-owner, a co-host), so their own
   entries are recorded too.
9. In the same Seam setup, the host is asked whether they have a thermostat or noise sensor to
   connect, and those devices are stored with their health.

## Non-goals

- Matching events to visits, time on site, and no-show or late flags. That's project 2, which reads
  the events this project stores.
- Guest codes per booking. They go with guest messaging (project 7), since the code has to reach the
  guest.
- Using sensor readings (quiet hours, freezing). Projects 4 and 5.
- Cameras, booking details and the hours log (projects 3 and 4).
- Any lock not reached through Seam, and Durin hardware. The lock adapter (below) is where those plug
  in later.
- A host app or web dashboard. The host works from their agent, as today.

## Anti-goals

These would make it a failure even if it works:

- A host without a connected lock sees any change in how their door code works.
- A code reaches anyone but the person it was made for, or works outside its window.
- A real lock code appears in tests, fixtures, logs, prompts, transcripts or the repository.
- The host's "the guests have left" step disappears for a host who didn't turn it off.
- A cleaner or pro is left at the door because a code didn't program and nobody found out.

## Constraints

- **Safety rules.** `AGENTS.md` and `docs/cleaner-core-safety-gates.md`: the door code goes only to
  the approved, opted-in cleaner, by the host's chosen channel. `docs/fixer-core-safety-gates.md`: a
  pro's code goes only to the pro's own phone for the visit. These hold unchanged. Goal 7 changes the
  release gate for hosts who turn it on, so the gates doc and its tests change with it, through a pull
  request.
- **Tests use only 555 numbers and made-up codes.** No test or Scratch run talks to Seam. A Seam
  sandbox run is a manual check, and sandbox codes are made-up.
- **Secrets.** Property Core's Seam API key and webhook secret are service secrets in the
  environment, never in code, logs or chat, and never a host's. A host's lock password never reaches
  Property Core: they sign in on Seam's page.
- **The boundary.** Every request resolves one tenant before it reads or writes
  (`docs/hosted-multitenancy.md`). Seam webhooks are a new way in and follow the same rule.
- **Many hosts on one service.** One Property Core Seam workspace serves every account.
- **Seam's pricing has changed three times since July 2026** (Cory's stack doc). All Seam calls sit
  behind one adapter.

## Approaches considered

How codes are created was the open choice:

| Approach | Trade-off |
| --- | --- |
| **A. Create each code when the visit is booked (chosen)** | Seam programs it hours or days ahead, so release hands over a code already on the lock, and a failure shows up early with time to fall back. Each code belongs to one person and visit, so every unlock names who came in. Needs a store of issued codes and updates when a window moves. |
| B. Create the code at release | Nothing stored ahead. But programming can take minutes, so the cleaner could wait at the door, and a failure surfaces at the worst moment. |
| C. A few standing codes on the lock, handed out per visit | Nothing to program. But a code works outside its window and is reused across people, which breaks one code per person per visit and makes events ambiguous. |

Saad chose A.

For the cleaner's code at checkout:

| Option | Trade-off |
| --- | --- |
| 1. Keep the host's yes for everyone | Safest; Cory still taps once per turnover. |
| **2. The host chooses per property (chosen)** | Hands-off for hosts who want it; the default stays as today. Changes the gate for hosts who opt in. |
| 3. Always automatic with a connected lock | Simplest; removes the check from every host with a lock. |

Saad chose 2.

## How it works today

- `src/hub/doorAccess.ts`: each property's `DoorAccess` keeps the host's code sealed in
  `door-access.json`. A flow asks `request({ person, window, purpose })` and gets back a grant. The
  answer comes from an `AccessProvider`, which today is `ownCode`: the saved code for the whole window.
  `useProvider()` already exists for a different provider.
- Cleaner Core (`src/cleaner-core/core.ts`, `requestAccess` and `deliverPin`) runs all its checks
  (approval, opt-in, stale feed, holds, channel), then asks the hub, then sends the code. The
  release waits for the host's "guests have left" (`mark_guests_left`). It awaits the request through
  its `DoorAccessPort` (`src/cleaner-core/doorPort.ts`).
- Fixer Core (`src/fixer-core/desk.ts`, `openCode` and `revealCode`) asks the hub synchronously when
  the pro taps "I'm at the door" on the visit page.
- Cleaner Core's leak checks (about 40: redaction, draft refusals, "is a code saved") work from one
  code in memory.
- The hub stores no record of the grants it gives (left out of the door-access spec).

## The design

### 1. The lock adapter

One interface Property Core owns, with Seam as the first implementation and an in-memory fake for
tests. No other code calls Seam.

- Connect: make a connect link for an account and property; list the connected devices.
- Codes: create a code on a device for a window, change its window, remove it, read its status, pull
  a backup code.
- Events: verify and parse an incoming webhook into Property Core's event shape.

The adapter makes the same code value on every connected lock in a visit, so the person gets one
code to type. If a lock refuses a value the others took, the adapter removes the codes it made and
tries a new value on all of them.

**Builder's call, with a test:** Cory asked for Seam's Access Grants interface. Use Access Grants if,
in the sandbox, they give time-bound PIN codes on a Yale lock with the same events and backup codes
described here. Otherwise use Seam's access codes. Either way, it's hidden in the adapter.

### 2. Connecting a host's locks (setup)

A new optional step, offered by `get_state` for any property with Cleaner Core or Fixer Core on,
behind the service flag `SMART_LOCKS=1`:

1. "Do you have a smart lock that works with an app? I can connect it so each cleaner and pro gets
   their own code." No moves on.
2. Yes: a tool (`connect_lock`) returns a Seam connect link. The host opens it and signs in to their
   lock account on Seam's page. The link isn't a secret, but it is single-use and names the account.
3. Seam tells us the account connected (webhook). `get_state` lists the account's devices.
4. The host picks which locks belong to this property and which ones the cleaner and pros go through
   (`save_locks`). This replaces asking the host to describe each lock, but the saved lock location
   text stays for the door-code message.
5. "Do you also have a thermostat or noise sensor in an app? I can connect that too." Yes gives
   another connect link. Their devices are stored with their health. Nothing else uses them yet.
6. If Cleaner Core is on: "Should the cleaner get their code at checkout time without you confirming
   the guests left?" Default no (see section 6).

After activation, changing the locks takes the host's yes, like every other change.

Seam marks each connected account with Property Core's account id (Seam's `customer_key`), and
Property Core keeps the mapping from Seam account and device to account and property. A device can
belong to only one property.

**Mixed doors (my call).** A property is on connected locks only when every door the cleaner and pros
go through is connected. If one isn't (a lockbox, a gate with a plain keypad), the property keeps the
host's saved code, and the host is told why. Mixing a per-visit code and a shared code in one message
isn't worth the confusion in v1.

### 3. Issuing codes ahead (approach A)

The hub gets a grants file per property (`door-grants.json`), next to `door-access.json`. One entry
per code: who it's for (phone), which flow and job, the window, the devices, the status per device,
the sealed code, and the backup code if one was pulled. The code is sealed with the same key and
`pinSeal` as the saved code, and opened only for release or a leak check.

The hub's `request()` becomes async. Every caller already runs in an async path: Cleaner Core awaits
it today, LiveDesk's door port and Fixer's `revealCode` are inside async functions, and Fixer's
`openCode` turns async with them.

The hub gets three new calls, used by the flows only when the property is on connected locks:

- `issue({ person, window, purpose, jobId })`: create the code now.
- `move(jobId, window)`: change its window.
- `revoke(jobId)`: remove it.

When each flow calls them:

| Event | Cleaner Core | Fixer Core |
| --- | --- | --- |
| Issue | The cleaner says YES to a cleaning | The host says yes to a booked visit time |
| Move | The checkout time changes (`confirm_times`, the host's later time), or the next check-in moves | The visit is rescheduled with the host's yes |
| Revoke | Cancelled, declined, a new cleaner takes it, or `hold_job` | The job is cancelled or Fixer Core turned off |

The window is the one each flow already works out: `cleaningWindow` for a cleaning, the visit window
with the check-in buffer for Fixer. Codes are removed by Seam at the window's end; `revoke` is for
early ends.

`request()` at release, on connected locks:

1. The grant for this job and person is `set` on every device: return its code.
2. A device shows it failed: pull a backup code for that device, keep it in the grant, return it, and
   tell the host. A backup code is used only for this person and job.
3. Still programming at release: wait up to two minutes (this is rare, since codes are made ahead),
   then do step 2.
4. No backup is possible: if the host saved their own code, return it and tell the host; otherwise
   refuse with a new reason (`lock-failed`), and the flow sends the host its one note as it does for
   any refusal today.

A property not on connected locks gets the saved code, exactly as today.

### 4. Leak checks with many codes

Cleaner Core's leak checks guard one code today. They change to guard a set: every live code on the
property (each grant's code and backup code, plus the saved code). The hub hands Cleaner Core that
set only for checks, the way `codeForChecks` does now. A grant leaves the set a day after its window
ends, so a late message quoting it is still caught.

### 5. Lock events

A new route, `POST /webhooks/seam`, signed by Seam and verified by the adapter before anything is
read. The tenant comes from the event's account mapping (section 2). An event for an unknown account
or device is dropped and logged without its body.

Each property gets `lock-events.jsonl`, append-only: the event as received, minus anything
code-like, plus Property Core's fields (property, device, kind, when, the grant it names if any).
Nothing edits a stored event. Project 2 reads this file to match visits.

Events that change something now:

| Event | What happens |
| --- | --- |
| Code set on a device | The grant's device status becomes `set` |
| Code failed to set | Pull a backup code for that grant and device. Tell the host. |
| Backup pool running low or empty | Tell the host once |
| Unlock with a code | Stored. If it's the cleaner's code on a checkout-time release, run the check in section 6. |
| Low battery | Tell the host once per device per low reading |
| Device offline, or back online | Tell the host when offline for 30 minutes, and when back |
| Lock account disconnected | Tell the host to sign in again, with a fresh connect link |

"Tell the host" uses the account's alerts routine, as Fixer and Cleaner Core do, so it reaches the
host's agent chat. These alerts work on a property with only Fixer Core on, the way the 12 Nov
alerts design made them.

### 6. The cleaner's code at checkout time

A per-property Cleaner Core setting, `codeAtCheckout`, off by default. It can be turned on only while
the property is on connected locks, and turns itself off (with a note to the host) if the locks
disconnect.

When it's on:

- At the cleaning's checkout time, Cleaner Core treats the checkout as cleared and sends the code,
  instead of nudging "Have the guests left?". Every other release check still runs: approval, opt-in,
  stale feed, holds, channel.
- The host gets a note: "Sent Maria the code for the 11:00 turnover. Say pause if the guests are
  still there." `hold_job` revokes the cleaner's code on the lock.
- When the cleaner's code first opens the door, if any other code opened it in the hour before, the
  host is told right away ("Maria just arrived. Someone else came in at 10:40."). The guest's code
  isn't Property Core's, so any unlock that isn't a Property Core grant or standing code counts.
- If the lock is offline at checkout time, the release falls back to today's flow: the nudge and the
  host's yes.

`docs/cleaner-core-safety-gates.md` changes its door-code gate to say this, with tests: off by
default, only with connected locks, every other check intact, the hold revokes, and the offline
fallback.

### 7. Standing codes

The host can give a named person a standing code on the property's locks: themselves, a co-owner,
or a co-host. It has no end date, the host can remove it anytime, and its unlocks are stored like
any other, named to that person. It's sent the same way the host saves a code today (the upload
link), never in chat. Cleaners and pros never get standing codes: theirs are always per visit.

### 8. What the host and agent see

- `get_state` shows, per property: connected or not, the locks and sensors with battery and online
  status, and any problem waiting.
- The agent never sees a code. Tools return codes' status, never digits.
- Guides: `CLEANER_CORE_BOOTSTRAP.md`, `FIXER_CORE_BOOTSTRAP.md` and the Muse skills add the lock
  step, the checkout-time question, and the alerts.

## Safety gates to add

A new section in `docs/cleaner-core-safety-gates.md` and `docs/fixer-core-safety-gates.md`, each with
tests on the fake adapter:

- A property with no connected lock gets today's saved code, unchanged.
- A code is issued only for the person and job named, and only after that flow's own checks.
- A code is never returned to a tool, logged, or stored unsealed.
- A cleaning or visit that's cancelled, declined or paused has its code revoked.
- A failed code falls back to a backup code or the host's saved code, and the host is told.
- A Seam webhook that fails verification changes nothing.
- An event never crosses accounts.
- `codeAtCheckout` is off by default, needs connected locks, keeps every other release check, and
  the hold revokes.

## Rollout

1. Build and test on the fake adapter. CI stays green, with no network.
2. Saad opens a Seam sandbox workspace. The builder runs the manual sandbox check: connect a sandbox
   Yale account, run a turnover and a Fixer visit, force a failed code, read the events.
3. `SMART_LOCKS=1` on the service only after the gates are green and Saad okays it.
4. Cory signs in to his Yale account on the connect page for Adélie. First real turnovers watched
   closely. The Chalet follows once its lock model is known.

## Left to the builder

- Access Grants or access codes inside the adapter (see section 1).
- File formats and field names.
- How the two-minute wait in release is done.
- Seam's webhook verification method and exact event names, checked against the live docs.
- How the fake adapter simulates programming delays and failures.

## Open, outside this project

- Guest codes and how they reach guests: project 7.
- Matching events to visits: project 2.
- Seam's per-lock cost: who pays, Property Core or the host. Cory's stack doc lists $1 per lock per
  month plus credits as of 10 Nov 2026.

## Questions from the builder review (not yet answered)

A reviewer read this spec as its builder on 2026-11-12. Saad paused project 1 to finish the build map,
so these wait for him. Most important first.

1. **Answered 2026-11-12: fine as is.** With `codeAtCheckout` on, the automatic release clears the day
   for pros too. The Fixer gates doc must say so. **Checkout-time release and pros.** Fixer Core lets a pro in on a checkout day once Cleaner Core
   counts the cleaning cleared, and it counts it cleared once the cleaner's code is sent. With
   `codeAtCheckout`, a pro booked that day would get their code without the host's guests-left.
   Intended, or should an automatic release be kept apart from a real clearance?
2. **Answered 2026-11-12: the code starts at checkout time, since that's when the cleaner is expected.
   If the cleaner says they're coming early and the host has cleared the guests, the code's start is
   moved earlier.** **The host clears the guests early.** A code made ahead starts at checkout time. If the host says
   the guests left early, does the code's start move to now (reprogramming at release), or does the
   cleaner wait until checkout time and get told so? Pros on a checkout day have the same question.
3. **Answered 2026-11-12: grants always use the account's own server key** (the per-account key in the
   tenant's secrets file, made if missing), whatever key the saved code uses. **Which key seals the
   per-visit codes.** The saved code may use a key the server holds only in
   memory. Codes are issued and opened with no host request present (the cleaner's YES, webhooks, the
   checkout timer, leak checks). May grants always use the account's server key?
4. **How a standing code reaches its person.** The host enters the digits and passes them on, or
   Property Core makes the code and shows it once to the named person (a new way a code leaves the
   system, with its own consent rules)?
5. **The pro's code window.** Fixer's current access window (30 minutes before the visit to its end or
   extension), or up to the check-in buffer? Does extending a visit count as a move?
6. **One of several locks falls back.** Two codes named by door, one fallback code for the whole visit,
   or the visit counts as failed?
7. **Resuming after a pause under `codeAtCheckout`.** Does resuming make a new code and send it
   automatically, or wait for the host's guests-left? The host likely paused because guests were
   still there.
8. **Urgent lock alerts without an alerts routine.** On agents or properties with no alerts routine,
   notes wait until the host opens chat. Should connecting a lock require a working routine, or do
   urgent lock problems need another way to reach the host?
