# Shared people across an account's properties

Date: 2026-11-07. Status: draft, decided in review with Saad on 2026-11-07.
Issue: saadvz/TourCore#190, part of saadvz/TourCore#158 (Phase 0). Follows
`docs/superpowers/specs/2026-11-07-property-hub-door-access-design.md`, and
lifts the "One property per person" rule from
`docs/superpowers/specs/2026-11-06-property-core-accounts-properties-design.md`.

## Goal

One phone can be a person (the cleaner, a co-host, an assistant or an
observer) on several of an account's properties, after the host confirms it in
the agent chat. A text from that person reaches the right property. Their
STOP covers every property. Nothing they receive names, hints at, or carries
another property's address, label or door code.

## What Saad said

- When a shared person's one-to-one text doesn't name a property, context
  goes first: if exactly one of their properties is waiting on a reply from
  them, the text goes there. Otherwise they're asked "which property?" (option
  A of three: B always asked, C asked once and then remembered the answer for
  a while).
- One YES per account. Consent is to texts from the landlord's line, so the
  first YES covers every property the host assigns (option A of two: B kept a
  YES per property).
- The cleaner and contacts can both be shared, in the same role or different
  ones (option A of two: B shared cleaners only).
- People live in an account list that holds identity, opt-in and assignments.
  Each desk keeps its own roles (approach 1 of three: 2 moved every person out
  of the desks, 3 kept no new store and copied STOP, START and YES to every
  desk).
- The host's confirmation follows the `dropJobs: true` pattern: the save is
  refused until the agent saves again with `shared: true`.

## Not in this version

- Pros (Fixer Core, #170 to #174). They join the same list later.
- Per-account texting consent in place of the operator allowlist (#164).
- Changing the group-mode START rule: a cleaner who STOPped in group mode isn't
  put back in the group by START.
- A one-to-one text from a phone that's on none of the account's properties.
  It is handled as today.

## What exists today

- `peopleRefusal` in `src/hosted/lineRouter.ts` runs before every
  `save_people` (`src/hosted/frontMcp.ts:197-200`). It opens each other
  property's desk and refuses with `phoneTaken`: "That number is already on
  12 Scratch Lane. For now one person can be on only one property." The
  landlord's phone may be the host on every property and a person on none.
- `afterPeopleSaved` copies the account's STOP list into the desk after a
  save (`desk.markOptedOut`).
- `routeLineText` routes a one-to-one text on the shared line. With one
  cleaning property, everything goes to it. With more, it picks the property
  whose saved people include the sender (`phonesOf` opens every desk on every
  text). The landlord's STOP and START go to every property they host. Any
  other landlord text changes nothing.
- STOP is kept in two layers:
  - `TenantOptOuts` in `<account>/opt-outs.json`, written by the router on
    every STOP and START it routes.
  - `lineOptOuts` in each desk's `cleaner-live.json`. The desk's sink sends
    nothing to a phone in it, drops a group post when any member is in it,
    and throws on a door-code text. START or YES lifts it only on the desk the
    text reaches (`inboundNow`).
- Opt-in lives in each property's engine store (`cleaner-job/cleaner-core.json`):
  - `cleanerConsent` for the cleaner, and `participantConsent` for contacts.
  - The desk's `cleanerConsent` option only seeds the engine when the store
    has none (`core.ts:908`).
  - The invite has the id `opt-in:<phone>` per engine. A YES counts only
    while `awaitingOptIn()`.
  - STOP is handled in `stop` and `stopMember`. START in group mode is ignored
    for a cleaner who opted out (`core.ts:3125`).
- In group mode, most of a person's texts are in the property's group, which
  arrives on the property's own path. One-to-one texts on the shared line are:
  - the YES to the invite
  - STOP, START and HELP
  - a group member's one-to-one reply, handled the same as a group reply
  - everything, when a property is `groupChat: "cleaner-only"`
- The engine's YES, NO and DONE logic doesn't check the channel. Whether a
  property is waiting on someone is private engine state:
  - `awaitingOptIn()`
  - `conversationJob()` (an offered job)
  - `checklistWaiting()`
  - `supplyWaiting()`
  - `progressJob()`
- HELP gets no reply from this code. Twilio answers it.
- `labeled()` in `liveDesk.ts` puts `"{label}: "` on group posts and texts to
  the landlord when the line has two or more properties. It never goes on
  one-to-one texts to a person.

## Design

### The account people list

A new file, `src/hub/people.ts`, keeps `people.json` in the account folder
(`tenants/<id>/people.json`). Like the rest of the hub, it never imports
Cleaner Core. Writes are atomic and one at a time on an in-memory copy, as in
`hub.json`.

```ts
interface PeopleFile {
  schemaVersion: 1;
  people: Person[];
}

interface Person {
  phone: string;           // E.164
  name?: string;           // the latest name the host gave
  optedIn?: { at: string; propertyId: string };   // the YES, once, for every property
  stopped?: { at: string };                       // their own STOP; removed by START
  invitedFrom?: string;    // the property whose invite is out, until the YES
  where: { propertyId: string; role: "cleaner" | "co-host" | "assistant" | "observer" }[];
}
```

- One entry per phone. An entry with an empty `where` stays, so a STOP keeps
  holding, the way `opt-outs.json` does today.
- The landlord's phone is never an entry. Their STOP and START keep working as
  today: on every property they host.
- `people.ts` exposes reads (`person(phone)`, `propertiesOf(phone)`) and these
  writes: `assign`, `unassign`, `markInvited`, `markOptedIn`, `stop`, `start`.
  Each write returns what changed, so the hosted layer can tell the desks.

### Saving people, and the host's confirmation

`peopleRefusal` in `frontMcp.ts` reads the account list instead of opening
every desk.

- A phone that's already a person on another property, and `shared` isn't
  `true` in the save: refused, to the agent only.
  - The refusal: "That number is already on 12 Scratch Lane as the cleaner.
    Ask the host whether the same person helps here too, then save again with
    shared: true."
  - With several matches, it names each one, with its role.
  - Nobody is texted.
- `shared: true` lets the save through. `save_people`'s schema takes it as an
  optional boolean. The desk ignores it.
- Still refused, with no override:
  - the landlord's phone as a cleaner or contact anywhere on the account
  - a phone that's a person anywhere as the host anywhere

After a save (`afterPeopleSaved`):

- The account list sets this property's `where` for every saved person, with
  their role.
- It removes this property from anyone no longer saved here.
- A new person with `optedIn` already set is told to the desk as opted in (see
  "One YES per account"). A new person with `stopped` set is told to the desk
  as stopped.

### Routing a shared person's one-to-one text

This applies only to a one-to-one text on the shared line from a phone that's
a person on two or more of the account's cleaning properties. Everything else
routes as it does today: a person on one property, the landlord, a phone on no
property, and every group text.

`routeLineText` reads the account list once per text. It no longer opens every
desk to compare phones. Its steps, in order:

1. **STOP and START** go to "STOP and START" below. **HELP** goes to no desk
   and gets no reply from this code. Twilio answers it, as today.
2. **A held text is waiting** for this phone (see step 5), and the text answers
   it: a number from the list, or a name match from step 3. The held text goes
   to that desk. The answer itself goes nowhere.
3. **The text names one of their properties.** A match is a whole word or
   phrase, ignoring case, on the property's label, its nickname, or the
   street part of its address (before the first comma). Only the person's own
   properties are checked. When exactly one matches, the text goes to that
   desk unchanged.
4. **Context.** Each of their desks answers a new read-only
   `waitingOn(phone)`. It is true when the engine:
   - has sent this person an invite and awaits their YES
   - has a job offered to them
   - has an open checklist or supplies question for them
   - has a cleaning in progress for them

   When exactly one desk says yes, the text goes there.
5. **Ask.** The line replies to that phone only:
   "Which property is this about? Reply 1 for 12 Scratch Lane or 2 for 4
   Court St."
   - It lists only their properties, by the street part of the address. Labels
     are the host's own names and aren't used.
   - The text is held in `<account>/line-asks.json`: one per phone, with its
     message id, text and photos, for 2 hours.
   - A later text that isn't an answer replaces the held one. A held text
     asks again at most once every 10 minutes per phone. Between asks, texts
     are held quietly.
   - After 2 hours unanswered, the held text is dropped. Each of their
     properties keeps a note for the host's agent chat: "A text from {name or
     their role} couldn't be matched to a property." The note carries none of
     the text's digit runs, as `noteUnusedHostText` does today.

A text that goes to a desk keeps its message id, so `seenInbound` and
`secondCopy` still drop a second copy.

### Texts to a shared person name their property

`labeled()` also puts the prefix on one-to-one texts to a person who is on two
or more of the account's properties. For a person, the prefix is the street
part of the address, never the label: "12 Scratch Lane: Thanks, cleaning
marked done." It names only the property the text is about.

### One YES per account

- **The first invite** goes out as today, from that property's engine, naming
  its address. The account list records `invitedFrom`.
- **Other invites are held.** While the account list shows an invite out from
  another property and no YES, a new engine option, `optInElsewhere: true`,
  stops the engine from sending its own invite. When the inviting property no
  longer has the person, `invitedFrom` is cleared, and the next property to
  run sends its invite.
- **The YES** reaches the inviting property by context (step 4). That engine
  sets the person to `in` as today. A new engine callback,
  `onConsent(phone, "in" | "out")`, reports the change to the desk. The desk
  records `optedIn` on the account list.
- **Every other desk** the person is on gets `accountOptIn(phone)`. It moves
  that engine's consent for the phone from `pending` to `in`, without a text.
  It never moves `out` to `in`. The engine then does what it does after a YES
  today: that property's group intro, naming only that property, or its next
  offer.
- **A property that adds them later** finds `optedIn` set. It tells its desk
  `accountOptIn` on the save, so it skips the invite and goes straight to its
  intro.
- The cleaner and contacts work the same way. For a contact, consent is the
  engine's `participantConsent`.

Opt-in never puts a person into a group or a door code release that the host
didn't set up for that property. Approval, the group and its members,
`doorCodeTo`, holds, jobs and the door code stay per property.

### STOP and START

**STOP**, in a group or one-to-one:

- The account list marks the person `stopped`. The router marks it on every
  one-to-one STOP it sees from a phone that isn't the landlord's, as it writes
  `opt-outs.json` today, whether or not the phone is on a property. A STOP in
  a group reaches the list through the engine's `onConsent`.
- Each desk they're on gets `accountStop(phone)`:
  - The engine moves the phone to `out`, with the same holds and the host
    note as a STOP today. One note per property goes to the host's agent chat.
    On a desk with no engine yet, the desk sets its own hold (`cleanerOut` for
    the cleaner), as `inboundBeforeJob` does today.
  - The desk sends no second STOP reply.
  - The desk's sink sends nothing to the phone, and drops a group post when
    any member is stopped. A door-code text to the phone throws. These are
    today's `lineOptOuts` rules, now read from the account list.
- A STOP in a group is handled first by that property's engine, as today,
  including its reply. Its `onConsent(phone, "out")` starts the steps above
  for the other properties.
- A one-to-one STOP from a person on two or more properties is taken by the
  router before any desk. The line sends one reply to that phone: "You're
  opted out of texts from {business}. Reply START to opt back in. Reply HELP
  for help."

**START**, one-to-one:

- The account list removes `stopped`. The router does this on every
  one-to-one START it sees from a phone that isn't the landlord's.
- Each desk they're on gets `accountStart(phone)`. That does exactly what that
  engine does with a START today, or what `inboundBeforeJob` does on a desk
  with no engine yet. In group mode, a cleaner who opted out stays
  out of the group, as the group-first design says.
- From a person on two or more properties, the line sends one reply: "You're
  opted back in to texts from {business}. Reply STOP to opt out."
- A YES from a stopped person also removes `stopped`, as `inboundNow` allows
  today. Then the text routes like any other.

`{business}` is the business name when all of the person's properties share
one. Otherwise it reads "this number".

### Boundaries

- `src/hub/people.ts` knows phones, properties and roles. It never imports
  Cleaner Core, and it never sends a text.
- The hosted layer (`src/hosted/lineRouter.ts`, `frontMcp.ts`) is the only
  caller that writes the account list and tells desks about a change.
- LiveDesk gets these new methods:
  - `waitingOn(phone)`, which reads only
  - `accountOptIn`, `accountStop` and `accountStart`
  - a `people` hook in its options, to read a phone's account state for the
    sink and the engine's options

  It writes the account list only through the `onConsent` callback.
- The engine (`core.ts`) gets the `optInElsewhere` option, the `onConsent`
  callback, and three methods that apply an account change without a text.
  Its door-code path doesn't change.

### Moving existing data

On the first open of an account after the deploy, `people.json` is built
from:

- Each cleaning property's saved people (cleaner, observer, contacts) with
  their roles. Today nobody is on two properties, so nothing conflicts.
- Each phone in `opt-outs.json` and in any desk's `lineOptOuts`, which
  becomes `stopped`.
- Each engine's stored consent `in`, which becomes `optedIn` with that
  property, and `out`, which becomes `stopped`.

`opt-outs.json` and `lineOptOuts` are then left unread, not deleted. The move
is repeatable: an interrupted move starts over from the same sources.

## Testing

All tests use 555 numbers and made-up door codes.

- **The leak test.** One account, two properties with different made-up door
  codes, and the same cleaner on both after `shared: true`. It drives:
  - a turnover with the door code on each property
  - one-to-one replies and group replies
  - STOP, START and HELP
  - "which property?", a held text and its answer

  Every text sent to that cleaner, one-to-one or group, is checked to contain
  none of the other property's address, street name, label, nickname or door
  code digits.
- **`people.ts`:**
  - assign, unassign, invite, opt in, stop, start
  - writes landing in order
  - the move from `opt-outs.json`, `lineOptOuts` and engine consent, and an
    interrupted move run again
- **Saving people:**
  - the refusal names the other property and the role
  - `shared: true` saves
  - the landlord's phone is still refused as a person
  - a person's phone is still refused as the host
  - nobody is texted by a refusal
- **Routing:**
  - a text naming a property goes there
  - with exactly one property waiting, the text goes there
  - with none or two waiting, the line asks
  - the ask lists only their properties
  - answering with a number or a name delivers the held text
  - a new text replaces the held one
  - an ask goes out at most once every 10 minutes
  - after 2 hours the held text is dropped, with a note on each property
  - a person on one property routes as today
- **One YES:**
  - a YES on one property opts them in on both
  - each property sends its own intro
  - a second invite is held while the first is out
  - a property added later skips the invite
  - `accountOptIn` never moves `out` to `in`
- **STOP and START:**
  - a STOP in a group or one-to-one blocks every property, with one reply
    one-to-one
  - START lifts it on every property, and the group-mode START rule holds
  - a door-code text to a stopped phone throws
- **What doesn't change:** `test/lineRouting.test.ts` and
  `test/twoPropertiesEndToEnd.test.ts` still pass. Only their
  one-property-per-person cases are rewritten.
- `npm test`, `npm run typecheck`, and the verify-cleanercore proof
  (`.cursor/skills/verify-cleanercore/scripts/prove-step-g.sh`) pass, with
  no live sends.

## Safety gates

The "Own property only" row in `docs/cleaner-core-safety-gates.md` changes:

- It drops "a phone can be a person on only one of the account's properties".
- It says:
  - A person is on several properties only after the host's `shared: true`.
  - Their one-to-one text that names no property goes to the one property
    waiting on them, or gets "which property?", which lists only their
    properties.
  - Their STOP covers every property.
  - No text to them names, hints at, or carries another property's address,
    label or door code.
- It links the leak test.

The door-code row doesn't change, and `AGENTS.md` doesn't change.

## Done when

- One phone can be the cleaner on two properties of one account after the
  host confirms it with `shared: true`.
- A shared cleaner's text that doesn't name a property, with no single
  property waiting on them, gets "which property?". It lists only their
  properties.
- One YES opts a shared person in on every property they're on, and a STOP
  stops texts on every one.
- No text to a shared person carries another property's name, address or
  code. The leak test proves it.
- The safety gates stay green.
