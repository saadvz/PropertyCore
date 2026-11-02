---
name: setup-property
description: Set up a self-guided touring property in Tour Core through a friendly, one-question-at-a-time conversation, then check it and run a practice tour before offering to publish. Use when the operator wants to add, set up, import or change a building.
when-to-use: "set up a property", "set up my building", "add a property", "I have a new building", "change the tour hours", "add a unit"
allowed-tools: get_state save_property save_units save_doors_and_routes save_hours save_facts save_settings set_up_texting run_checks publish remove_property pause_tours
argument-hint: "[address]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Guided property setup, checked and practiced before publish
  version: "0.3.15"
---

# Setup Property

Call only `get_state`, `save_property`, `save_units`, `save_doors_and_routes`, `save_hours`, `save_facts`, `save_settings`, `set_up_texting`, `run_checks`, `publish`, `remove_property`, and `pause_tours`.

Tour Core is the system of record. Everything you learn goes into Tour Core
through its tools the moment the operator says it; nothing about the property
is kept only in this conversation. Read `context/operator-language.md` and
`context/safety-boundaries.md` in the Tour Core template before starting.

## When to use

The operator wants to set up a property, change its type, add or change units,
doors, tour hours, verification or messaging. For route questions on their own, use
**Map Route**.

## Required inputs and access

- The Tour Core connector must be connected (see the template setup guide).
- From the operator, in this order: address; property type (single-family
  home, multifamily, or apartment or condo — one unit); the units or spaces
  people can tour; for an apartment or condo, whether they control the
  building entrance or only the unit door, then the entrance name if they
  control it; the entrance(s) they control; any hallway doors on the way;
  each unit's basic information (bedrooms, bathrooms, monthly rent,
  availability are required; square footage, floor, description, parking,
  laundry, pets, utilities, furnished and features are offered); optional
  entry instructions; tour days and hours; how careful to be about checking
  IDs. A property or building name only if the operator offers one.
- Never ask for API keys, secrets, passwords or phone-provider credentials.
  Those are collected with a secure secret input during install, never in chat.

## Sequence

Ask one question at a time, in everyday words. Show what you inferred and let
the operator correct it. Start with `get_state`. Ask `nextStep.say` and call
`nextStep.tool`. Call `get_state` again after each save. The tool it names is
one of these:

| `nextStep.tool` | What you save |
| --- | --- |
| `save_property` | Address, type, time zone, name, building access, entry instructions, visitor help number |
| `save_units` | The places people tour, and their bedrooms, bathrooms, rent, and availability |
| `save_doors_and_routes` | Entrances, hallway doors, and the walking route. `preview: true` shows the match and saves nothing |
| `save_hours` | Tour days and hours |
| `save_facts` | The property facts sheet: how to apply, fees, lease, move-in, bringing someone, rules, the area, anything else |
| `save_settings` | The identity form, and tour updates |
| `set_up_texting` | How people text about a tour, when texting is the step that is next |
| `run_checks` | The readiness check and the practice tour |
| `publish` | Publishing, after a clear yes to the question it returns |
| `backup_records` | A portable copy, or skipping one. That step belongs to **Backup Tour Core** |
| `get_inbox` | Day-to-day work, once this place is published |

1. `get_state`. Its `properties` list is the places already on file. If the
   address already exists, say so and continue with that property.

2. Texting is an install-wide choice, set once with `set_up_texting`. On a fresh
    install, `get_state` asks **"How should people text you about a tour?"** Ask
    that question and call `set_up_texting` with the provider they choose. One
    touring number covers every property. Don't ask for a separate number per
    property. Once texting is installed, a later property uses it automatically
    and is not asked again. When `get_state` names `set_up_texting` after that,
    call `set_up_texting` without asking the question again. If texting is
    installed and this property is still on practice texts, `set_up_texting`
    with `provider: sendblue` and that property yourself. `set_up_texting` sets
    the provider and checks it. It does not ask the operator for a login in chat.
    `provider: local` puts this building on local test texts without drafting other published buildings.
    For local, say "Visitor texting: test mode" and
    "Texting is in test mode, so texts
    don't reach real phones. Real visitors won't get anything until live texting is
    turned on. Door access is still in demo mode, so no physical locks will open."
    Do not say texting is live and do not name the texting service.
    Where
    records live comes from `get_state` `storage` (this computer, or Google Drive).
    Don't ask about it.

3. When `get_state` names `backup_records`, follow **Backup Tour Core**. Skipping is fine. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. `c = json.load(f)["contents"]` `hashlib.sha256(json.dumps(c, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")).hexdigest()`

4. Ask **"What's the property address?"** when `nextStep.say` is that
   question, or ask the `say` `get_state` already returned. Then `save_property`
   with the address. A US address needs a street, city, state and ZIP. Ask for one
   missing part at a time and keep every part already given. If the reply
   is "What's the street address?", ask that and save it with
   `save_property` `street`. If it is "What state is it in?", ask
   that before any city question and save it with `state`. A city given while
   the state is still missing is kept; the reply is "Got it. What state is
   that in?". Ask "What city should I use?" only once the street and state
   are saved, and save the answer with `save_property` `city`. Do
   not invent a city or a state. If the reply is "What ZIP code should I
   use?", ask that and save the answer with `save_property`
   `postalCode`. Do not invent a ZIP. Then read the address back on one line,
   exactly as Tour Core shows it
   ("Did I get that right: 300 Main Street, Unit 4B, Hackensack, NJ 07601?"
   when the address has a unit, and the same line without the unit when it
   does not) and wait for yes. Never read an address back with a blank city.
   A street on its own keeps its suffix and any unit ("144 Hillside Avenue" stays that street). Until a state is known, do not mention a time zone. A street with no state or ZIP leaves the time zone unset. An older saved GMT+00:00 with no state is read as unset. A published property with no usable time zone (including an older GMT+00:00 with no state, or a file with the time zone field missing) stops tours. The file is not rewritten. Visitors get the normal human-path reply. A tour already in progress finishes normally. No new tour or reservation starts until a zone is set. Say to the landlord: "This property doesn't have a time zone set yet, so tours can't run. What time zone should tours use, like Eastern or Pacific?" `get_inbox` shows that as Time zone needed, with no id, until a zone is set. Setting Eastern or Pacific brings tours back and clears that item. When a guess is the only thing left to say, say "I'm using {Eastern} time for tours. Want a different one?" When a setup question follows the guess, say "I'm using {Eastern} time for tours. You can change that anytime." and then that one question, for example "I'm using Eastern time for tours. You can change that anytime. What ZIP code should I use?" A guessed time zone updates only before the address is confirmed, and never on a property that was published or already had a confirmed address or an operator-set zone. When the summary already asks the next question, the next question is omitted. Ask the summary once. When a state change would move a locked zone, ask the switch question first, on its own: "Tours still run on {current} time. Should I switch to {new} time?" Do not add the next setup question until they answer. timezone "yes" switches to the offered zone. timezone "no" keeps the current zone. A named zone such as "Pacific" or "keep Eastern" is that choice. A ZIP is not a yes and does not switch. A ZIP or other detail sent while that question is open is held, not saved yet. The reply is "Before I save that, one thing. Tours still run on {current} time. Should I switch to {new} time?" Once they answer, what they sent while the question was open is saved. Do not send it again. A ZIP that does not match the state is not saved. Changing only the state runs that same check and saves nothing until it is answered. Ask "That ZIP doesn't look like it's in {state}. Which one should I fix, the ZIP or the state?" and save the part they fix. An end time of 11:59 PM is said as midnight. The stored hour stays 23:59.
   Only after `confirmAddress: true` ask property type. Pass `name` only if the operator
   said a public property or building name themselves; never suggest one, and
   never treat an internal space name such as "Main Home" as the property name.

5. Ask Tour Core's next question, **"Is this a single-family home, a multifamily home, or one apartment or condo?"**,
   in plain words: single-family home; multifamily (duplex /
   small building you own); apartment or condo (one unit). Never guess the
   type from the address. There is no whole-building apartment option. Save
   the answer with `save_property` (`propertyType`: `SINGLE_FAMILY`,
   `MULTIFAMILY_HOME`, or `APARTMENT_OR_CONDO`). It returns the
   next question about the spaces people tour.

6. Ask about the tourable spaces the way that type needs. `get_state` names
   `save_units` for this step.
   - **Single-family home:** people tour the whole home. Ask whether to call it
     "Main Home" or something else, then `save_units` (leave `name` out for
     "Main Home"). Its door is the home's entrance ("Front Door" unless the
     operator names it) and its route is set on its own. Never make up a unit
     number.
   - **Multifamily:** ask **"Which units can people tour?"** For each,
     `save_units` with the operator's own name and description. Each unit gets
     its own door automatically ("Unit 1A Door").
   - **Apartment or condo (one unit):** ask **"What's the unit number?"** then
     `save_units` with that number (`"4B"` is stored as `"Unit 4B"`; `"loft"` as
     `"Unit Loft"`).      `save_units` `newName` uses the same casing when they rename
     (`"loft"` is stored as `"Unit Loft"`). Then
     ask Tour Core's next question: **"Do you control the building entrance, or
     only the unit door?"** `get_state` names `save_property` for that question.
     Save `buildingAccess` `BUILDING_AND_UNIT` or
     `UNIT_ONLY` with `save_property`. If they control the building
     entrance, ask **"What's the building entrance called?"** `get_state` names
     `save_doors_and_routes` for that question. Call
     `save_doors_and_routes` with that door `kind: entrance` — Tour Core sets the route as building entrance + unit
     door. If they only control the unit door, the route is that door alone
     (no building door on the route or in arrival text). The nickname is the street
     plus unit (`145 Main St, Unit 4B`), never "Main Home". Mid-tour texts
     say `at Unit 4B`; a single-family home says `the front door`, never
     "Main Home".

   Never write a description or fact yourself.

7. Doors: ask **"Which door do visitors come in through?"** when this type
   has a building entrance they control. `save_doors_and_routes` with `kind: entrance`.
   Ask **"Any hallway or inside doors on the way to the units?"** Add each as
   `kind: hallway`. Add only doors the operator named. A single-family home
   already has its entrance; ask only if they want to rename it or there are
   inside doors. An apartment or condo that only controls the unit door has
   no building door to add. `get_state` names `save_doors_and_routes` for the route.

8. Routes: follow the **Map Route** skill for each unit (`save_doors_and_routes`
   with `preview: true`, show the operator, then `save_doors_and_routes` with the exact names). A single-family
   home's route is already set. An apartment or condo route is set when they
   answer the building-door question (and name the entrance, if they control
   it).

9. **Unit information, after doors and routes.** `get_state` names `save_units`
   while a required detail is still open. Ask for bedrooms, bathrooms,
   rent and availability, and accept a natural answer for several units at
   once ("1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for
   $2,800"): pass it as `details` to `save_units`. On a single-family
   home with exactly one unit, omit the unit name and Tour Core uses that
   unit. Save the home with `save_units` before saving details when it is not
   a unit yet. Multi-unit properties still need a
   unit. Offer the optional
   details (square footage, floor, parking, laundry, pets, utilities,
   furnished, features) once. "I don't know", "not sure", "not available yet"
   and "don't list the price" are answers: pass them as the operator said
   them. Never fill in or guess a value. `save_units` returns a short
   confirmation and, if anything required is still missing, `get_state`
   `nextStep.say` is the one question to ask
   (e.g. "When are these units available?"). Ask only that; don't re-ask what's
   known. When nothing is missing, read the lines back and ask **"Does that look
   right?"**:

   > Unit 1A — 2 bed · 1 bath · $2,300/month · available now
   > Unit 1B — 1 bed · 1 bath · $1,950/month · available October 15

   Corrections go through `save_units` too. These details are approved
   facts: visitors' questions ("How many bedrooms?", "How much is it?", "When
   is it available?") are answered from them first, at any point in their
   conversation. An apartment or condo still asks building-door control (`save_property`) and the entrance
   name (`save_doors_and_routes`) before the route counts as done. Entry instructions
   come after the profile. Ask the optional
   **"How should visitors get in and find your unit?"** Save their words as
   `entryInstructions` on `save_property`, or `skipEntryInstructions: true` if they skip.
   Skip stores nothing. Visitors hear those words only after identity
   verification, on the you're-all-set text.

10. Ask Tour Core's next question about visitor help word for word. `get_state`
    names `save_property` for that step:
    **"What number can stuck visitors call? Someone should answer it during touring hours. You can skip this."**
    Save a number with `save_property` `visitorContact`. If they skip,
    call `save_property` with `skipVisitorHelp: true` so it is not
    asked again. Never use the team's private alert line as the visitor number.
    The number stays optional.

11. Ask **"When can people tour?"** when `get_state` names `save_hours`. Pass their words to `save_hours`
   ("weekdays", "9 to 5", "every day"). A new property starts at
   Monday–Friday, 9:00 AM–5:00 PM. When hours are already saved, say the
   line from `get_state` `nextStep.say`, built from those hours (for example
   "Tours run every day, 4 AM to 11 PM. Want to change that?"). Do not recite
   a weekday 9-to-5 line when that is not what is saved. Mention the other
   visible defaults once (45-minute tours, a new tour every hour, 10 minutes
   early) and change any they want. If tours would start more often than a
   visit lasts (tour length plus early arrival), `save_hours`
   refuses and saves nothing. Say that refusal as returned.
   A tour shorter than 15 minutes or longer than 4 hours is refused with
   `Each tour should last between 15 minutes and 4 hours. How long should each tour be?`
   Spacing under 15 minutes or over 8 hours is refused with
   `New tours should start between 15 minutes and 8 hours apart. How often should a new tour start?`
   Hours stay as they were. Valid default hours are still offered before
   checks. `get_state` stays on hours until `save_hours`
   confirms them. A published property, or one whose readiness or practice
   tour already passed, already counts as confirmed.
   The units question, when that step is actually next, is **"What are the
   units called? For example, Unit A and Unit B."** After doors and routes
   are saved, do not stay on that question. An address that is already set up
   is read back as the saved full address, not the raw characters just typed.

   When `get_state` names `save_facts`, ask `nextStep.say` word for word, one
   question at a time. Pass their answer as `text` with that question's
   `topic` (`apply`, `fees`, `lease`, `move_in`, `guests`, `rules`, `area`,
   `other`). If they skip, call `save_facts` with `skip: true`. Each answer is
   saved word for word and told to visitors who ask. A line saying who should
   live there is refused; say the refusal as returned. A published property
   can add or change facts anytime with `save_facts`.

12. When `get_state` names `save_settings`, ask **"Should visitors fill out a short identity form before their tour? I recommend it, so you know who's coming in."**
   Options: "Basic identity form (recommended)" and "No form". The basic form is the default.
   If they pick no form, ask **"Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?"**
   Call `save_settings` with `verification: none` only after they say yes, and pass the confirmation code it returns.
   Do not ask how many days the form lasts, and do not mention reuse. Read it back as **"Verification: No identity form."**
   If they say no, leave the basic identity form.
   If they keep the basic form, the reuse question is **"How many days before a visitor fills out the form again?"**
   Help: **"A visitor who already filled out the form can book another tour within this many days without filling it out again."**
   The default is 30. A number outside 1 to 365 is refused and nothing is saved.
   Say **"Pick a number of days from 1 to 365."** Do not read an out-of-range
   number back. If the property is already on no form, do not ask the no-form
   confirmation again. Read the basic form back as **"Verification: Basic identity form (recommended)".**
   Save the basic form with `save_settings` `verification: basic-form`.
   Tour updates on that same tool: ask only the question `get_state` returns.
   `skipAlerts: true` when they skip updates.

13. `get_state` and read the property back as a short list from `setup`,
    `units`, `routes`, `hours`, `verification`, and `texting`:

    > Here's what I have:
    > 144 Hillside Ave, Teaneck NJ
    > Multifamily (duplex / small building you own)
    >
    > Unit 1A
    > 2 bed · 1 bath · $2,300/month · available now
    > Route: Main Entrance → Unit 1A Door
    >
    > Unit 1B
    > 1 bed · 1 bath · $1,950/month · available October 15
    > Route: Main Entrance → Unit 1B Door
    >
    > Tours: Monday-Friday, 9:00 AM-5:00 PM
    > Verification: Basic identity form (recommended)
    > Visitor texting: Connected
    > Door access: Demo
    > Visitors can call: not set
    >
    > Does that look right?

    If the operator gave the property a name, a "Called: ..." line follows the
    address. If they set a help number, that line shows the value instead of
    "not set". A single-family home's unit heading is the street line
    (for example "910 QA Gate Rd"), never "Main Home". Multifamily, apartment
    and condo units keep their stored names. Local or test-mode texting reads
    "Visitor texting: test mode" instead of "Connected".

14. On yes, the setup is saved. Go back to `get_state`. It names `run_checks` once tour updates are saved. Then say "I'll run a readiness check and a practice tour before we turn it on." and run **Run Readiness Check**. If it fails, explain each problem in plain words and
    offer the fix; change nothing without the operator's OK. If it passes, the
    same `run_checks` call is the practice tour. Say **"The check passed, and the practice tour passed."**
    only when `run_checks` says that.

15. If both passed, `publish`. It returns one question; ask it
    word for word. Only after a clear yes, call it again with the
    `confirmationCode` and wait for the result. Then `get_state`
    and say it is published only if that says so.
    Do not ask again, and do not say it still needs a yes, after a successful
    publish. Calling it again when it is already published changes nothing.
    If it is blocked because visitor texting is connected but the property isn't
    using it yet, call `set_up_texting` with `provider: sendblue` and that property,
    then `run_checks`, then ask the
    publish question again. After publishing, say each part as `publish` returns it: "Visitor
    texting is live. Door access is still in demo mode, so no physical locks
    will open." For local test texts, use the test-mode sentence plus the door
    line, and do not say visitors can start a tour by texting the touring
    number. Never say "everything runs in demo mode".

**Pause, resume, or remove.** These are not setup edits and do not change the
published configuration. `pause_tours` stops new bookings at a property or one
unit (ask the exact question it returns; if tours are already booked, the
operator chooses keep or cancel). A tour in progress always finishes.
`pause_tours` with `paused: false` turns bookings back on and texts people who were told tours
would be back (or who got a paused-unit line). A later visitor Tour, Hi, or
book restarts booking the same way as a first text. `remove_property` takes the
property off the list after the exact confirmation — including an unpublished
setup `get_state` still shows (same lookup by id, name, or address),
whether or not that setup is complete. Booked visitors get a cancel text that
the property isn't offering tours anymore (not that they'll be texted when
tours are back) and pending door access is switched off. Waiting visitors are
not texted that tours are back. A later text to that line gets a goodbye and
cannot book. It is refused while someone is on a tour. Published records stay
(`export_records`, `get_tours`) — including a property sent back to draft
when it still has a publish timestamp, visitor tour or reservation records, or a
publish event in its audit. A practice tour alone does not count. An unpublished setup is removed completely.
Ask the exact question it returns: unpublished (complete or not) uses
**Remove the setup for {name}? It isn't published yet, so no visitors are
affected, but everything entered for it will be deleted for good.** Published
with no bookings says **No one is booked, so no cancel texts go out.** One
booked visitor is singular (**1 booked visitor gets**). {name} is the
operator-given property name, or street plus unit when there is exactly one
unit, otherwise the street line — never "Main Home". After yes on a draft,
say **Removed the setup for {name}.** Otherwise keep
Tour Core's wording. Say
**remove**, never archive. This is not `hold_tour`, which pauses one
visitor's tour.

Later edits: facts and unit details (bedrooms, rent, availability,
description, amenities, directions) and the visitor help number are approved
content: saving them keeps the property published and active tours use them
right away. A practice tour's T+15 close includes that number when it is set.
Doors, routes, tour hours, verification and messaging are structural: they send
the property back to draft until readiness and a practice tour pass again. Tell
the operator which it is before saving a structural change to a published
property. After
the new hours are published, anyone already texting picks them up on their
next message: a stale numbered day gets "Tour times just changed. Here's
what's open now:" and the fresh days; "Tour" starts the day picker over from
the current hours; an offered next opening is checked against those hours
before it is booked.

## Validate

- Every change came back without an error, and `get_state` shows it.
- The next step is `run_checks` before you offer the readiness check.
- If a tool returns an error, tell the operator what it said in plain words and
  ask how to proceed. Don't retry with guesses.

## Return

A short, friendly summary of the property as Tour Core has it, the readiness
and practice-tour results, and whether it's published for demo.

## Requires approval

- Publishing (always, via the tool's own confirmation).
- Changing anything the operator didn't ask for, including fixes suggested by
  the readiness check.
- Removing units or doors: not available through Grok; point the operator to
  the Tour Core app on the computer.

## Stop when

The property is published for demo, or the operator stops, or a tool reports a
problem only the operator can fix (for example messaging that isn't connected on
the Tour Core computer).
