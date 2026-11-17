# Nightly stay check: house rules and the night's check

Date: 2026-11-17. Status: approved in the project thread, for Saad's review.
Issue: saadvz/PropertyCore#239, a child of #236 (verification roadmap).
Builds on #244 (`stayForNight`, merged in #248). Runs ahead of the camera
connection, which waits on the Grok test #249. How the alert reaches the host
waits on #250.

## Why

The tester's biggest block of owner time is the nightly look at the lock and
camera apps during a stay: more people than booked, a pet on a no-pet stay,
extra cars, noise in quiet hours. About 15 minutes a night. Property Core
should do that look and tell the host only when something is wrong.

This version builds the part that doesn't depend on which camera path wins:
the host's own house rules, and the check of one night's events against the
booking and those rules. It runs on sample events. The Ring connection fills
in real events later, through the same event shape.

## Goals

- The host's agent asks the host for their house rules, in the host's own
  words, with examples. Nothing is filled in ahead of time.
- Each rule is saved as the host wrote it. A rule the cameras can watch
  (guests, pets, cars, quiet hours) is also saved as a check, once the agent
  has read the check back to the host.
- For one night of a stay, the check compares the night's events with the
  booking and the checkable rules and returns either "clean" or a list of
  flags with the alert text and the best supporting clip.
- A flag the host marks false makes that rule need one more sighting at that
  property next time, up to 3.
- The host can allow something for one stay ("this weekend's guests bring a
  dog, that's fine").

## Not in this version

- Real camera or noise events. The Ring connection (#239, after #249) and the
  lock partner's noise sensor (#180) feed them later.
- Our own people, car and animal counting from snapshots. Sample events carry
  the counts the counting step will produce.
- Sending the alert, a scheduled nightly run, and a tool to mark a flag
  false. #250 decides which bot reaches the host, and there is nothing to
  mark until alerts go out. The false-flag rule itself is built and tested.
- Pets from the booking. Airbnb's emails as read by #248 don't carry them.
- Fixer Core's outdoor visits, the stay timeline, camera-offline alerts.

## Anti-goals

- No house rule the host didn't give. A property with no checkable rules is
  never checked, and nothing changes for a host without cameras.
- A false flag never raises the allowed headcount, car count or noise limit.
  It only asks for more sightings, so a real party still gets caught.
- A rule never holds a door code. Rule text that looks like one is refused.
- The check never texts anyone. It returns a result; delivery is #250's.
- No guest is identified. Counts only.

## Approaches

1. **Free text plus an optional structured check per rule** (chosen). The
   host's words are kept exactly; the agent maps a rule to one of four check
   kinds when it fits and reads the check back. Rules nobody can watch are
   still kept for the timeline and claims. Deterministic checks, the host's
   wording preserved.
2. **A fixed form of four fields** (max guests, pets, cars, quiet hours).
   Simple, but it puts our list in front of the host's rules, and the user
   ruled it out: house rules are the host's.
3. **Free text only, judged by a model each night.** Flexible, but the
   nightly result would depend on a model's reading of the rule every night,
   and a false flag couldn't be tied to a rule's threshold.

## Design

### Where it lives

A new folder, `src/stay-check/`, like `src/hours-log/`:

- `rules.ts`: the rule and check types, validation, and the false-flag rule.
- `store.ts`: `stay-check.json` in the property's folder.
- `events.ts`: the provider-neutral event shape.
- `check.ts`: `checkNight`, a pure function.
- `alert.ts`: the alert text.
- `desk.ts`: one property's desk: save and read rules, allow for a stay, and
  run one night against given events.
- `tools.ts`: the tools as `tools/list` shows them, and their handler.

On the shared service, `src/hosted/stayCheck.ts` lists and answers the tools,
the way `src/hosted/hours.ts` does for the hours log. Off unless
`STAY_CHECK` is `1` or `true` (`stayCheckOn` in `src/cleaner-core/flag.ts`),
documented in `docs/environment-variables.md`. Listed while the flag is on
and any property runs a flow; each tool takes `property`. Nothing records
whether a property has cameras yet, so the flag is the only gate in this
version, and setup never brings up house rules on its own: the agent asks
when the host wants the nightly check. The camera connection adds the
per-property camera gate. (Builder check: my call.)

### Rules

```ts
type CheckKind = "people" | "pets" | "vehicles" | "quiet";

type RuleCheck =
  | { kind: "people"; max?: number }      // no max: no more people than booked
  | { kind: "pets" }                       // no pets
  | { kind: "vehicles"; max: number }
  | { kind: "quiet"; start: string; end: string; noiseLimit?: number }; // "HH:MM", dB

interface HouseRule {
  text: string;        // the host's words, 1 to 200 characters
  check?: RuleCheck;   // only when the agent read it back and the host agreed
}
```

- Up to 20 rules. At most one check of each kind; a second is refused with
  a plain reason.
- `people.max` 1 to 50, `vehicles.max` 0 to 20, `noiseLimit` 30 to 120 dB,
  times as 24-hour `HH:MM`. A quiet window may cross midnight.
- Rule text that may carry a door code is refused: any run of 4 or more
  digits (also split by spaces, dots or dashes; clock times like 22:00
  aside, so "Quiet 22:00-07:00" passes), or anything
  `redactBookingEmail` would take out. The shared service has no property's
  saved code to hand, so this is the same rule Cleaner Core uses while the
  code is sealed. House rules don't need long numbers; "Quiet after 10 PM"
  and "6 guests" pass. (Builder check: my call.)

### The record: `stay-check.json`

```ts
interface StayCheckFile {
  rules: HouseRule[];
  checkTime?: string;                               // "HH:MM", the host's pick
  rulesSavedAt?: string;
  sightings: Partial<Record<CheckKind, number>>;    // needed per kind; unset is 1
  allowances: { checkIn: string; allow: CheckKind[] }[]; // per stay, by check-in date
}
```

An unreadable file is a plain refusal and is never written over, as with
`hours.json`. `markFalse(file, kind)` sets `sightings[kind]` to one more than
it was (unset counts as 1), never past 3.

### Events

```ts
interface MediaRef { device: string; at: number; durationMs?: number } // by reference, never copied

interface StayEvent {
  id: string;
  at: string;                       // ISO time
  source: "camera" | "noise";
  device: string;                   // the camera or sensor's name
  label?: string;                   // the provider's label as given, like "human" or "vehicle"
  counts?: { people?: number; vehicles?: number; animals?: number }; // our own count
  noiseDb?: number;
  loud?: boolean;                   // the sensor's own noise alert
  snapshot?: MediaRef;
  clip?: MediaRef;
}
```

Labels are passed through as the provider gives them; the check reads only
`counts`, `noiseDb` and `loud`. Ring's partner API labels are human, vehicle,
package delivery and other motion, with no animal label, so animals come from
our own count.

### Which night, and which booking

`runNight(date, events)` on the desk, for a local date `YYYY-MM-DD` at the
property's time zone (the hub's `timeZone`; no time zone, no check):

- **Skipped** when the property has no checkable rule, or the hub's calendar
  stays show no stay covering the night (check-in night counts, checkout
  night doesn't). An empty house is #240's.
- **The booking** is `stayForNight(root, date)`. Its `guests` is adults plus
  children; when the matching booking's `guestBreakdown` lists infants, the
  people allowance is one higher, because a camera sees them. `stayForNight`
  doesn't return the breakdown, so `EmailStay` gains an optional `infants`.
- **The run time** for the night of `date` is the check time on `date`, or on
  the next day when the check time is before noon (a 2 AM check belongs to
  the night before it). The default check time is 23:00 until the host picks
  one; the agent offers 11 PM as a suggestion.
- **The window** runs from the previous night's run time to this night's run
  time, with two exceptions, so turnover day is never counted against a
  stay and its last night is checked in full:
  - On check-in night it starts at the stay's check-in time: the booking
    email's `checkInTime`, else the hub's `checkInTime`, else 16:00.
  - On the last night (the night before checkout) it ends at the checkout
    time on checkout day: the email's `checkoutTime`, else the hub's
    `checkoutTime`, else 11:00. That night's result is ready then.

  No window reaches back before the stay's check-in, whatever the check
  time. Events outside the window are ignored. (Builder check: my call.)

### The check

`checkNight({ rules, sightings, allow, booking, timeZone, window, events })`:

| Kind | Counts as a sighting | Allowed |
|------|---------------------|---------|
| people | a camera event with `counts.people` over the allowed number | `max` when there is no guest count; the booked guests (plus one for infants) when there is no `max`; the smaller of the two when both |
| pets | a camera event with `counts.animals` of 1 or more | none |
| vehicles | a camera event with `counts.vehicles` over `max` | `max` |
| quiet | a noise event inside the quiet window (local time) over `noiseLimit` when one is set, else one the sensor marks `loud` | — |

- People and cars use the most seen in any one event, never a sum across
  events, because the same guests come and go all evening.
- A kind flags when its sightings reach the needed number (1, raised by false
  flags up to 3).
- A kind is not checked, and listed under `unchecked` with a reason, when the
  stay has an allowance for it, or a people rule without `max` has no booked
  guest count, or the night has no noise events for a quiet rule.
- Each flag carries its kind, the peak (most people, most cars, loudest), the
  allowed number, the sightings, the rule's text, and the peak event's clip
  (or its snapshot when there is no clip).

The result is one of:

```ts
| { status: "skipped"; reason: string }
| { status: "clean"; unchecked: Unchecked[] }
| { status: "flags"; flags: Flag[]; unchecked: Unchecked[]; alert: string; evidence?: MediaRef }
```

A clean night sends nothing, and the result says so.

### The alert text

One message for the night, every flag in it, in the property's time zone,
plain words, no door code, no guest's name:

> Tonight at Lake House: 8 people on camera at 9:14 PM, booked for 6. An
> animal on camera at 10:02 PM, and the house rules say no pets. Clip: Front
> door camera, 9:14 PM.

`evidence` is the clip of the first flag's peak. Links to the clip come with
the camera connection.

### Tools

- `get_house_rules`: the saved rules, the check time and the allowances. With
  none saved, it tells the agent to ask the host for their house rules in
  their own words, with examples ("No more than 6 guests", "No pets", "Two
  cars max", "Quiet after 10 PM", "No parties"), and to read back each rule
  the cameras can watch in checkable form before saving it.
- `save_house_rules`: `{ rules?, checkTime? }`. `rules` replaces the list.
  The description says to save a `check` only after the host agreed to the
  read-back, and to save other rules as text.
- `allow_for_stay`: `{ checkIn, allow }`, after the host says so. An empty
  `allow` removes the stay's allowance.

## Testing

- `test/stayCheckRules.test.ts`: validation, the door-code refusal, the
  one-check-per-kind rule, `markFalse` and its cap.
- `test/stayCheckNight.test.ts`: `checkNight` on sample events in
  `test/fixtures/stay-check/`: a clean night, each flag kind, max-in-one-event
  not sum, infants allowance, a quiet window across midnight, sightings after
  false flags, allowances, unchecked reasons, the alert text.
- `test/stayCheckDesk.test.ts`: the desk over a temp property folder with a
  hub calendar and a booking email log: skipped with no rules, no stay, or no
  time zone; the booking read; the window from the check time.
- `test/stayCheckTools.test.ts`: the tools on the shared service behind the
  flag, with `property`, listed only with the flag on.

Made-up data only: 555 numbers, no real codes, no real addresses.

## Left to the builder

- Copy wording beyond the examples above, in the repo's plain style.
- File names inside `src/stay-check/` if a split reads better.
- Whether `unchecked` reasons go in the alert. Default: they don't; they're in
  the result for the agent.
