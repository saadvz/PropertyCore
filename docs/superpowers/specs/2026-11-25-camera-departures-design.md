# Camera departures in visit records

Date: 2026-11-25. Status: approved on 25 Nov with approach 1 (the camera gives
the time when the lock gave none), and built on `claude/camera-departures-237`.
Issues: saadvz/PropertyCore#237 and #240, which both list this as a follow-up
now that a Ring account can be linked (#302, #307).
Builds on visit records (`2026-11-19-visit-records-design.md`), the camera
adapter (`2026-11-19-camera-adapter-design.md`) and the same-day check on real
entries (`2026-11-20-oversight-real-entries-design.md`, #275).

## Why

A visit's departure is the cleaner's DONE or the pro's "done", and its time is
moved to the lock's time when a door is locked from outside close to it. Two
things make that weak today:

- It isn't known yet whether the test property's lock reports a lock from
  outside at all (still open on #237). When it doesn't, every departure is just
  the time the person texted, which can be before or after they left.
- A property with cameras and no connected lock has nothing to check DONE
  against.

Camera events are already in the same visit log (`camera` and `camera-count`
lines). Visit records don't read them.

## Two earlier decisions this has to fit

- **19 Nov (visit records):** each departure records its source so camera
  evidence can replace the DONE time later, "when it lands within the same
  match window".
- **20 Nov (#275):** a person seen on a camera supports a visit but never
  confirms it alone.

They fit together like this: **DONE says the person left. The camera can only
say when.** A camera never makes a departure on its own.

## What a camera can and can't say

Ring sends motion events with a label (`human` with Smart Alerts on), and we
may have our own count for the event. It does not say who the person is, and it
does not say whether they were coming or going. So a "camera departure" is not
"the camera saw Maria leave". It is "a person was seen outside, on a camera the
host picked for this property, at about the time Maria said she was done".

## Goals

- When a visit has a DONE and a person was seen on a picked outdoor camera
  close to it, the record says so, with the camera's name and time.
- When the lock gave no time for the departure, the camera's time is the
  departure time, so time on site is closer to the truth.
- The record always says where the departure time came from.
- The rule is one pure step inside `buildVisits`, rebuilt from the raw lines
  like everything else.

## Not in this version

- Camera arrivals. Arrival stays with the lock, the person's own words and the
  visit page.
- Any new text, note or alert to anyone.
- Counting more events. Our counter still runs for the nightly check's events
  only; an event with no count uses Ring's label, as in #275.
- Named entries with time on site for the manager's visits (#240's other
  follow-up).

## Anti-goals

- No departure is ever created from a camera alone. No DONE, no departure, and
  the `no-done` flag stands, whatever the cameras saw.
- A camera never overrides the lock. A lock from outside is tied to the door;
  a person on a camera could be anyone.
- No identity. Nothing says the person seen was the cleaner or the pro.
- No image, clip or link in the record. Only the camera's name, the event's id
  and its time, which are already in the log.
- A property without cameras, or an account with Cameras off, gets records
  identical to today's.

## Approaches

1. **DONE confirms, the camera gives the time only when the lock didn't**
   (recommended). Order for the departure time: a lock from outside, then a
   camera sighting, then DONE's own time. The sighting is always attached as
   support when there is one.
2. **Support only.** The sighting is attached to the departure, but the time
   stays the lock's or DONE's. Safest reading of #275, but time on site doesn't
   improve, which was the point of leaving room for cameras on 19 Nov.
3. **The camera makes a departure by itself** when there is no DONE (last
   person seen before the window ends). Rejected: it breaks #275's rule, and
   with no direction or identity a next guest or a neighbour would end a visit.

## Design (for approach 1)

### What counts

A **sighting** is #275's "person seen", minus the doorbell: a `camera` line of
kind `motion` whose latest count has 1 or more people, or with no count, whose
label is `human` or `person`. A doorbell press isn't used, because someone
leaving doesn't ring. Only lines from cameras the property has picked are in
the log, and every picked camera is outdoors.

A visit's **departure sighting** is the last sighting that is:

- from 15 minutes before DONE to 60 minutes after it (the lock's own match
  window, so one set of numbers);
- after the arrival, when there is one;
- before the next unlock after DONE, and before the next check-in. After
  either, a person outside is more likely someone arriving.

The last one, not the first, because a cleaner carrying bags to the car passes
the camera more than once. (My call.)

### How it sits beside DONE and the lock

| DONE | Lock from outside near DONE | Sighting | Departure time | Record says |
| --- | --- | --- | --- | --- |
| yes | yes | yes | the lock's | lock matched, camera seen |
| yes | yes | no | the lock's | lock matched |
| yes | no | yes | **the camera's** | camera seen |
| yes | no | no | DONE's | as today |
| no | any | any | none (`no-done`) | as today |

A crew day has no DONE of its own and takes its departure from the last lock
from outside. That stays. With a lock departure, a sighting is attached as
support; without one, a sighting makes nothing.

### The record

`Departure` gains three fields. `source` keeps meaning who said they were done
(`done-text`, `done-page`, `done-pro-text`, or `lock` for a crew day), so a
camera is never the source.

```ts
/** Where the time came from. */
timeFrom: "lock" | "camera" | "done";
/** "seen": a person on a picked camera near DONE; "none": cameras on, nobody seen; "no-camera": cameras not read. */
cameraCheck: "seen" | "none" | "no-camera";
/** The sighting, when cameraCheck is "seen". Support: it never confirms a departure by itself. */
camera?: { at: string; device: string; eventId: string };
```

`RULES` goes from 1 to 2. The unused `"camera"` value comes out of
`DepartureSource`.

### When cameras are read

`buildVisits` takes `cameras: boolean` in its context. It is true only when
the account's Cameras switch is on, the same switch #275's check reads. With
it false, camera lines are ignored and every record is `no-camera`.

A camera that was offline around DONE gives no sighting, so the record reads
`none`. It isn't told apart from "nobody walked past". (My call: the
departure doesn't depend on it, and offline cameras already get their own
alert.)

### Where it shows

- `list_visits`: the departure carries the three fields, and its description
  says a camera time is support for DONE, not proof of who left.
- Hours log: a measured row's reference already names the departure's source.
  It adds ", time from the Front porch camera" when `timeFrom` is `camera`.
  Which rows count as measured doesn't change: a cleaning still needs a lock
  arrival.
- The same-day check (#240) is unchanged. It already reads sightings as
  support for an entry.

### Safety gates

One line added to the Visit records rows in
`docs/cleaner-core-safety-gates.md` and `docs/fixer-core-safety-gates.md`: a
camera never makes a departure without a DONE, never moves a time the lock
gave, is read only with the account's Cameras on, and adds no text or note.

### Tests

Fake camera lines only, 555 numbers, no code digits. In
`test/visitDerive.test.ts`: each row of the table above; a sighting outside
the window; a sighting after the next unlock or check-in; last of several
wins; a count of 0 people beats a `human` label; a doorbell press isn't used;
cameras off gives today's records field for field; a crew day; the rule
version. In `test/visitHoursLog.test.ts`: the reference line. In
`test/visitsHosted.test.ts`: the tool shows the fields only with Cameras on.

## Decision (25 Nov)

Approach 1: the camera's time becomes the departure time when the lock gave
none.

## As built

- `sightingNear` in `src/visits/derive.ts` is the whole rule. For a crew day
  it is anchored on the last lock from outside instead of a DONE.
- The Cameras switch reaches `buildVisits` from each caller: `list_visits`,
  the hours log, Cleaner Core's clock pass and Fixer Core's. So the usual
  clean length (the median of measured cleans) is the same number everywhere.
- A month of hours the host already confirmed changes its rows only if a
  sighting moves a departure in it, and then `review_hours` asks the host to
  confirm again, as for any changed row.
- The hosted test is in `test/visitsHosted.test.ts`, the hours log's in
  `test/visitHoursLog.test.ts`.
