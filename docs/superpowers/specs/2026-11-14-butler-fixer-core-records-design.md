# Butler and Fixer Core: who holds an owner's pros and upkeep schedules

Date: 2026-11-14. Status: **decided 2026-11-20: option B, for now.** Fixer
Core holds the owner's pros and upkeep schedules; nothing reads from Butler.
The split is revisited when Property Core works with Butler's Book later.
This doc's option C stays here as the starting point for that.
Issue: saadvz/PropertyCore#245, part of #236. The decision unblocks the
vendor-visit part of #237 and #243.

## The question

Fixer Core and Butler both hold an owner's pros and their recurring upkeep
schedules (pest, lawn, HVAC and so on). Two copies drift: a schedule changed
in one isn't seen by the other, and a pro removed in one is still contacted
by the other. Each record needs one owner, and the other system reads it.

## Before anything else: what Butler is

Nothing in this repository describes Butler. There's no Butler code, adapter,
spec or setting. The only mention is the Butler's Book row in
`docs/fixer-core-pro-networks.md` (#175), which found it is a household
manual (contractors, utilities, maintenance dates) and not a service, with no
API. Saad's public repositories don't include a Butler project either.

This doc assumes Butler is a separate system, run by Saad or by someone he
works with, that holds a trade network and recurring trade schedules, as the
issue describes. **If Butler is Butler's Book, or anything else with no API,
options A and C have nothing to read, and the answer is B.** The host's
contractors and dates come into Fixer Core once, in setup step 1, where the
agent already drafts pros "from what it can read" and the host confirms each
one.

## What Fixer Core holds today

Fixer Core is built and stays off behind `FIXER_CORE=1`. From
`docs/superpowers/specs/2026-11-07-fixer-core-design.md` and
`src/fixer-core/store.ts`:

- **One `fixer.json` per property** with the settings, up to 60 pros, up to
  30 upkeep items and the jobs.
- **A pro** has a name, trades, `preferredFor` (a rank per trade), how to
  reach them, `prefersText`, `status: "draft" | "saved"`, and where it came
  from (`host`, `drafted` or `job`). Every pro with a phone is also a person
  in the account's `people.json` with role `pro`, which holds their YES,
  their STOP and the `shared: true` rule across properties.
- **An upkeep item** has a trade, what to do, a schedule (`every` or
  `custom`, Supply Core's `schedule.ts`), `leadDays`, an optional `proId`,
  and `lastDoneAt`. `check_fixes` lists it as due `leadDays` before its next
  date, counted from `lastDoneAt` or `savedAt`. The agent opens a job with
  `source: "upkeep"` and the item's id in `sourceRef`, and the job waits for
  the host's go.
- **Every change** to a pro or upkeep after Activate needs the host's
  two-call yes.
- **Removing a pro** is refused while they're booked or have a live contact,
  and clears them from any upkeep item. **Removing an upkeep item** leaves an
  open job from it in place. When that job finishes, there's no item left to
  update.
- **The adapter pattern already exists.** The hub's door access asks an
  `AccessProvider` (`src/hub/doorAccess.ts`), today `ownCode`, later a lock
  partner (#180). #236 makes it a principle: every outside supplier sits
  behind an adapter we own.

## Recommendation: option C, split by job

Butler owns the trade network and the recurring trade schedules. Fixer Core
owns everything specific to one host and every decision the host makes.
Fixer Core reads Butler through an adapter and keeps the last good copy, so
it never needs Butler to be reachable to run.

### Who owns each record

| Record | Owner | The other system |
| --- | --- | --- |
| A pro in the trade network: name, trades, area, how to reach them | Butler | Fixer Core reads it and links it to its own pro |
| A recurring trade schedule (pest every quarter, lawn every week, HVAC filters every 3 months) | Butler | Fixer Core reads it and turns each due date into a job |
| The host's preferred list: which pros, and their order per trade | Fixer Core | Never written to Butler |
| A host's own pro who isn't in Butler | Fixer Core | Butler doesn't see it (see question 7) |
| Upkeep the host adds that Butler doesn't schedule | Fixer Core, unless Butler takes writes (question 3) | |
| Jobs, contacts, shortlists, bookings, visit windows, door access, the visit page, photos and the cost log | Fixer Core | Butler may get a "done" date back, later (question 3) |
| Every host approval (contact, booking and access, cost) | Fixer Core | Never Butler |
| Texting consent (YES and STOP) | `people.json` in the hub | Never Butler |

### The rule that keeps the gates as they are

**Being in Butler never approves anything.** A pro read from Butler arrives
as a draft and can't be contacted until the host confirms them, exactly like
a pro the agent drafts today. A schedule read from Butler opens a requested
job that waits for the host's go, exactly like today's upkeep. Butler can't
pick a pro, book, set a cost or share door access. So
`docs/fixer-core-safety-gates.md` keeps every gate, and gains one row for
this rule.

### Why not A or B

- **A (Butler holds everything, Fixer Core reads)** puts the host's
  preferred list and approvals in a system whose rules aren't in our code.
  The gates doc holds those rules in Fixer Core's code, with tests. A also
  stops Fixer Core when Butler is down, and rewrites the most of what's
  built.
- **B (Fixer Core holds everything, Butler reads)** costs nothing in Fixer
  Core, since it's today's code. It ends Butler's role as the source for the
  trade network. It's the right answer if Butler has no API, and the
  fallback if the answers below make C too costly.

## Answers to the issue's questions

### 1. What does Butler store for pros and schedules, and is there an API?

**Only Saad or Butler's owner can answer this.** The repository has nothing
on it (above). The adapter in this doc needs, at least, a read per property
or per host of: pros (an id, name, trades, phone in E.164 and email) and
schedules (an id, trade, what, the pro if any, and a schedule we can turn
into `every` or `custom`). The more specific questions are at the end.

### 2. Is a host's own preferred pro a Butler record, a Fixer Core record, or both, linked?

**Both, linked, when the pro is in Butler's network. Fixer Core only, when
they aren't.**

- Butler owns the pro's own details: name, trades and how to reach them.
- Fixer Core owns the host's relationship with that pro: the preferred rank
  per trade, whether the host confirmed them, whether the pro asked to
  text, which phones got the text invite, and the last job.
- Fixer Core's `Pro` gains `butlerRef`, Butler's id for the pro. The match
  is made once, when the host confirms the pro, and the host sees it ("Joe's
  Plumbing, from Butler"). Matching by phone alone is a proposal, since
  `people.json` already keys people by phone (question 5).
- When Butler's details for a linked pro change, Fixer Core uses the new ones
  from the next read. A new phone is a new person in `people.json`, so it
  needs the pro's own YES again before any text.
- A host's pro who isn't in Butler stays a Fixer Core record with
  `source: "host"`. Whether Fixer Core offers it to Butler is question 7.

### 3. Who edits a schedule: the host through their agent, the pro, or Butler?

**Proposal: whoever edits it in Butler today keeps doing so, and Fixer Core
never edits a Butler schedule on its own.** Who that is in Butler is a
question for Butler's owner (question 4).

- **The host, through their agent:** if Butler takes writes, `save_upkeep`
  and `remove_upkeep` on a Butler item write to Butler after the host's
  two-call yes, and Fixer Core reads the result back. If it doesn't, those
  tools refuse a Butler item and the agent tells the host where to change
  it. Either way the host can change what's Fixer Core's on a Butler item:
  `leadDays` and which of their pros to call.
- **The pro:** never through Fixer Core. A pro's text or call is news, and
  never changes anything (Texting consent gate).
- **Butler:** owns the schedule, so its changes win, and Fixer Core reacts
  as in question 4.

### 4. What happens to a Fixer Core job when Butler changes or removes a schedule?

**Nothing already agreed with a pro changes without the host. Fixer Core
tells the host once and lets them decide.**

| When Butler's change lands | What Fixer Core does |
| --- | --- |
| No job open for the item | The next due date comes from the new schedule. No news. A removed item opens no more jobs. |
| A job is open, nobody contacted yet (`requested` or `shortlisted`) | The job stays. The host is told once: `Butler moved the gutter cleaning to April 3. Keep this repair open or cancel it?` |
| A pro was contacted or a booking waits for the yes (`contacted`) | Same question. The agent never tells a pro about a change before the host decides. |
| Booked or in progress | The booking and its door access stand, under their own gates. The host is told once and can cancel or rebook with `cancel_job` (two-call), which ends the visit link while the agent tells the pro, as today. |
| Butler removes the item | As above for any open job, and the item is kept as `butlerGone` with the job until it closes, so the job's done date still has a home. |
| Butler removes a pro | The pro is no longer offered as the next preferred pro until the host confirms them again. A booking with them stands, and the host is told once. The host's preferred rank is kept, so a yes restores it. |
| Butler can't be read | Fixer Core keeps using the last good copy, like calendars after a failed read. Host jobs and the preferred list work as normal. The host is told once if reads fail for 24 hours (a proposal). |

This is the same rule as today: removing an upkeep item leaves its open job
in place. The change is that the host now hears about it, since the change
came from outside.

## What changes in Fixer Core

These become follow-up issues once Saad picks C. None changes behavior for
a host without Butler.

1. **An adapter we own**, `src/fixer-core/butler.ts`: a `ButlerSource` with
   reads for pros and schedules, the way `AccessProvider` works. The default
   is `none`, today's behavior. Tests use a fake source only.
2. **A stored copy** of each read, with when it was read, beside
   `fixer.json`. Fixer Core works from it between reads.
3. **Upkeep gains** `origin: "fixer" | "butler"`, `butlerRef` and
   `butlerGone`. On a Butler item, `save_upkeep` changes only Fixer Core's
   fields (`leadDays` and the pro) unless Butler takes writes, and
   `remove_upkeep` is refused.
4. **Pro gains** `butlerRef` and `butlerGone`.
5. **Setup step 1** drafts the host's pros from Butler's network for the
   property, as drafts the host confirms.
6. **`check_fixes` gains** the news in question 4: a changed or removed
   schedule with an open job, a removed pro, and Butler unreadable.
7. **Schedule mapping**: a Butler schedule Fixer Core can't express as
   `every` or `custom` is refused and listed for the host, never guessed.
8. **The gates doc gains a row**, "Butler never approves", with tests that a
   Butler pro can't be contacted before the host's yes, and that a Butler
   change never moves or cancels a booking.

## Questions only Saad or Butler's owner can answer

Most important first.

1. **What is Butler?** Who runs it, and is it the Butler's Book manual from
   #175 or a different system? If it has no API, the answer is B.
2. **Is there an API Fixer Core can read,** and how is access given: one key
   per deployment, or each host links their own account? What does a read
   return per pro and per schedule?
3. **Can Fixer Core write to Butler:** a new pro, a schedule change, a visit
   marked done? Without writes, a host changes Butler schedules in Butler.
4. **Who edits schedules in Butler today:** the host, the pro, or Butler's
   own staff?
5. **How does Butler identify a pro?** By phone, or by its own id? And does
   Butler hold any texting consent? Ours stays in `people.json` either way.
6. **What does a Butler schedule look like?** Fixer Core needs it as
   `every` or `custom`.
7. **Is Butler one network per host, or shared across hosts?** If shared, a
   pro one host trusts isn't approved for another, and a host's own pro
   shouldn't reach Butler without the host's yes.
8. **Do routine vendors like pest control and lawn already come on their
   own fixed schedule?** If so, those visits don't need Fixer Core to
   contact and book anyone. They need a visit window, a code and a visit
   record (#237's pest visits). That's close to the spec's "Later" item,
   "recurring pros for upkeep booked without a new question each time", and
   may deserve its own issue.

## Done when

- Saad picks an option, and the decision is recorded on #245 and as a
  decision in the Fixer Core design doc.
- The changes above are opened as issues, if C is picked.
