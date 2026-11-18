# Package arrivals: expected deliveries and the bring-it-in visit

Date: 2026-11-17. Status: proposed in the project thread, built on the
recommended approach while the host is away; for Saad's review.
Issue: saadvz/PropertyCore#241, a child of #236 (verification roadmap).
Builds on Supply Core's orders (#160s, ordering made optional in the
supply-core-ordering change), the shared people list (#190) and the hours log
(#238). Camera confirmation waits on #239's camera connection. The per-visit
lock code waits on #180.

## Why

When the owners are away, packages sit on the porch. The tester's deliveries
mostly arrived while they were away and waited more than a week on average,
and many had no dated delivery confirmation at all. Supply Core already knows
what it ordered and when each order should land. Nothing confirms the package
arrived, nothing gets it inside, and nothing records who brought it in.

## Goals

- Every placed Supply Core order with an expected date is an **expected
  delivery** at its property, with no extra step from the host's agent.
- A delivery is **seen** when something confirms the drop, with its time:
  carrier tracking (Supply Core's `mark_delivered`), the host saying so, or
  later the camera (#239). The record keeps which one it was, so a camera
  confirmation is told apart from a carrier claim.
- A package **expected but not seen by end of day** is flagged to the host
  once.
- **Someone brings it in.** The host picks a saved, opted-in person on that
  property (the cleaner, a co-host or an assistant). The host can save one
  default person; each delivery can name someone else. The visit's window
  opens at the drop and closes after the host's own number of hours.
- A bring-in visit not done by its deadline is flagged to the host once.
- **The log.** The hours log gets the delivery time (Property Core's own row,
  0 hours) and the bring-in visit (the person's own log, from when they
  started to when it was inside, when those times are known).

## Not in this version

- The bring-in code. The visit is recorded with its person and window, and the
  reply says plainly that the code comes with the lock connection (#180).
  Nothing here texts anyone, the person included: until the code exists, the
  host tells their person themselves.
- Camera confirmation itself. `how: "camera"` is accepted so #239's
  connection can call the same desk function, but nothing reads a camera yet.
- Carrier notices in the host's email. The record is keyed by source
  (`supply:<orderId>`) so an email source can add its own keys later.
- Large freight and white-glove deliveries (the visit-records project).

## Anti-goals

- Never invent a drop. A delivery is seen only on a carrier, host or camera
  signal, never because its expected date passed.
- Never pick the person for the host. A saved default counts as the host's
  pick; with no default and no person named, the desk asks.
- Never let someone who hasn't opted in, or who said STOP, be the bring-in
  person.
- Never write the owner's time for this. A bring-in is the person's work; a
  drop is Property Core's record.

## Approaches

1. **Inside Supply Core's record.** Add arrival fields to each order in
   `supply.json` and fold the new calls into Supply Core's tools. Fewest new
   files, but the email source (deliveries Supply Core never ordered) has no
   home there, and a second writer of `supply.json` would race the Supply
   Core desk.
2. **Its own small record and tools, reading Supply Core's orders
   (chosen).** `packages.json` in the property folder holds only what this
   feature adds (seen, visit, brought in, flags told). Expected deliveries
   are read from `supply.json` on each call, never copied. Tools are listed on
   the shared service behind `PACKAGE_ARRIVALS=1` while a property runs
   Supply Core, like the hours log and stay check. Email and camera sources
   plug in without touching Supply Core.
3. **A general "visits" record shared with Fixer Core and the visit-records
   project.** The right long-term home for every non-cleaning visit, but it
   would reshape Fixer Core's bookings and the visit-records project before
   either needs it. Too big for this issue.

## Design

### Record

`packages.json`, one per property, beside `supply.json`:

- `settings.bringInHours`: the host's own number of hours (1 to 72) from the
  drop to when it should be inside. Unset means the desk asks.
- `settings.person`: the default bring-in person's phone, or unset.
- `arrivals["supply:<orderId>"]`: `seen` (`at`, `how`), `notSeenTold`,
  `visit` (`person`, `name`, `role`, `plannedAt`, `hours`: the bring-in
  hours when it was planned, so a later change doesn't move its deadline),
  `broughtIn` (`at`, optional `startedAt`, optional `note`), `lateTold`.
- `salt`: random per property, set with the first visit. A helper's hours log
  key is an HMAC of their phone with it, never a plain hash.

A broken `packages.json` is a plain refusal and is never written over, like
`hours.json` and `stay-check.json`. A `supply.json` that can't be read is a
plain refusal too.

### Expected deliveries

From `supply.json`: orders with status `placed` or `delivered`. An order
Supply Core marked delivered counts as seen by `tracking` at its
`deliveredAt`, unless the package record already has an earlier signal. An
order with no `expectedBy` is listed as expected with no date and is never
flagged not-seen (its deadline still drives Supply Core's own `late`).

### End of day

A delivery expected on a date is not seen when the property's local date is
after that date, or it is that date and the local time is 21:00 or later
(my call: late enough for evening carrier drops, early enough to act on).
Without a saved time zone everything is still listed and only this flag
waits, with a `timeZone` line asking for the property's address.

### Tools

All take `property` on the shared service.

- `check_packages`: what's expected today and later, `notSeen` (flagged once,
  then kept in `waiting` without the flag), `toBringIn` (seen, no visit yet,
  with the default person when one is saved), `visits` (open, with their
  deadline, and a `problem` when the person can't any more, like a STOP
  since), `bringInLate` (flagged once), and `defaultPerson` (the saved
  default's name, with a `problem` when they can't be used). With no `bringInHours` saved
  it carries `ask` for it. The Supply Core Check routine calls it after
  `check_supplies`.
- `mark_package_seen` `{ orderId, how: "tracking" | "host" | "camera", at? }`:
  records the drop. An earlier signal is kept; a camera signal replaces a
  carrier or host one at any time, since it's the one the issue asks for.
  When a default person is saved, the visit is planned at once; when they
  can't be used, the reply says who and why in `defaultSkipped`. A time
  before the order was placed, or after the package was marked inside, is
  refused.
- `plan_bring_in` `{ orderId, person? }`: the bring-in visit. The person
  must be on this property as cleaner, co-host or assistant in the shared
  people list, opted in, and not stopped. Planning before the drop is
  allowed; the window opens at the drop. The reply carries the deadline and
  `code: "waiting"` with a line for the host.
- `mark_brought_in` `{ orderId, at?, startedAt?, note? }`: closes the visit.
  Refused before the delivery is seen or without a visit. A second call is
  refused unless the host is correcting it with `replace: true`.
- `save_package_settings` `{ bringInHours?, person? (null clears) }`: only as
  the host says.

### Hours log

Two new row kinds, each with a placeholder code in a new group, Packages:

- `package-drop` (`PKG-1`, Package delivered): Property Core's log, at the
  seen time, 0 hours, referencing the Supply Core order and how it was seen.
- `bring-in` (`PKG-2`, Bring a package inside): the person's own log (the
  cleaner's log for the cleaner, otherwise a log of their own), from
  `startedAt` to `at` when both are known, timing `measured`. Without
  `startedAt` it is a single moment with a `needs` line for the host's
  review.

Rows come only from deliveries `check_packages` has listed (each gets an
entry in `packages.json` when first listed), so turning the feature on never
changes a month the host already confirmed from older Supply Core orders.
Deliveries are listed while placed or expected within the last 30 days, or
while a bring-in visit is open.

Neither kind is an owner kind, so the routing rules keep both out of the
owner's log.

## Left to the builder

- Exact wording of replies, in the repo's plain style.
- How the helper log key is formed, as long as it never shows a phone.
