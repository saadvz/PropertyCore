# Property Core: accounts with several properties, flows switched per property

Date: 2026-11-06. Status: draft, decided in review with Saad on 2026-11-06.
Issue: saadvz/TourCore#161, part of saadvz/TourCore#158 (Phase 0).

## Goal

One account holds one or more properties. Each property switches Cleaner
Core, Supply Core and Fixer Core on or off on its own. One account runs
Cleaner Core and Supply Core on two properties at once, on its one text line.
Existing live setups keep working through the move.

## What Saad said

- One text line per account. People can later be shared across the account's
  properties, but a cleaner gets texts only about the properties the host
  assigned them in setup. Nothing a cleaner receives names or hints at
  another property.
- When a cleaner is confirmed working two properties, the cleaner may be asked
  which property they mean, and that question lists only their own
  properties. Who works which property is settled with the host in the agent
  chat before any text goes out.
- The host runs everything from the agent. With two or more properties, the
  landlord's own one-to-one texts to the line change nothing except STOP and
  START.
- The agent names the property in each tool call, with a `property` argument.
- Shared people, the host's confirmation and "which property?" come in #165.
  Until then a phone can be a person on only one of the account's properties.
- Each property keeps its own folder, and Cleaner Core's and Supply Core's
  desks stay as they are (approach A of three: B kept the first property in
  the account root, C put several properties inside the desks).
- Touring is parked. New accounts aren't offered touring. Its tests keep
  passing.

## Not in this version

- Shared people across properties, the host's confirmation of them, and
  "which property?" to a cleaner (#165).
- Sign-up, the account's phone check and the number pool (#162, #163).
- Per-account texting consent (#164).
- Removing or renaming a property.
- Anything Fixer Core does. Its switch is stored and refused.
- New touring paths.

## What exists today

- `src/cleaner-core/hosted/registry.ts`: a `Tenant` has one `twilioNumber`,
  one `service` (`"cleaning" | "touring" | "supplies"`, unset until chosen),
  and a `supplies` add-on flag. `tenants.json` is `schemaVersion` 2.
- `tenantContext` (`src/cleaner-core/hosted/router.ts`) gives every desk the
  tenant folder `tenants/<id>/` as its root, and an env whose
  `PUBLIC_BASE_URL` is `/t/<id>` (`tenantEnv.ts`).
- `LiveDesk` (`src/cleaner-core/liveDesk.ts`) and `SupplyDesk`
  (`src/supply-core/desk.ts`) are one per folder, each for one property.
- `src/hosted/frontMcp.ts` routes tools by `tenant.service`.
  `src/hosted/serviceTools.ts` and `src/hosted/service.ts` hold
  `choose_service`, `switch_service` and `stand_down_service`.
- A text to `/webhooks/twilio/cleaner-core` finds its tenant by the `To`
  number and branches on `tenant.service` (`router.ts`). Group webhooks,
  status callbacks, upload pages and photo links live under `/t/<id>/`.
- The engine still acts on the landlord's own texts: YES to join the group,
  a departure text that releases the door code without a group, `retry`,
  `booked on airbnb`, STOP and START (`src/cleaner-core/core.ts`).
- `drainAllTenants` delivers each cleaning tenant's waiting alerts.

## 1. Data model

`tenants.json` goes to `schemaVersion` 3. The account stays the `Tenant`
record with the same `tnt_` id, number, connections and invites. Code keeps
the name `Tenant`; docs call it an account.

```ts
interface Tenant {
  // unchanged: id, label, twilioNumber, primaryGrantId, connections, invites,
  // disabled, createdAt, lastActivityAt, serviceChangedAt
  /** Only "touring" remains, for parked touring accounts. They have no properties. */
  service?: "touring";
  properties: Property[];
}

interface Property {
  id: string; // "prp_" + 10 of [a-z0-9]
  label: string; // "12 Scratch Lane"
  createdAt: string;
  flows: { cleaning: Flow; supplies: Flow; fixer: Flow };
  /** The migrated property: its links stay under /t/<tenantId>/. */
  legacyPaths?: true;
}

interface Flow {
  on: boolean;
  changedAt?: string;
}
```

`supplies` and the `"cleaning"` and `"supplies"` service values are gone
after the migration. `fixer.on` can't be set to true in this version.

### What lives where

| Account folder `tenants/<id>/` | Property folder `tenants/<id>/properties/<pid>/` |
| --- | --- |
| `secrets.json`, `service-audit.jsonl`, `service-notices.json`, `opt-outs.json`, the account's line opt-outs (section 3), everything touring | `cleaner-live.json`, `cleaner-job/`, `cleaner-alerts/`, `photos/`, `supply.json`, `cleaner-approvals.json`, `cleaner-draft-approvals.json`, `supply-approvals.json`, `supply-approvals-front.json` |

`LiveDesk` and `SupplyDesk` get the property folder as their root. Nothing
else in them changes, apart from the two small hooks in sections 3 and 4.
The door-code and photo keys stay per account, so a code sealed before the
migration still opens.

### Each property's env

`buildTenantEnv` takes the property too:

- `PUBLIC_BASE_URL` is `/t/<id>` for a property with `legacyPaths`, and
  `/t/<id>/p/<pid>` for any other.
- `CLEANER_CORE_PROPERTY_ID` and `CLEANER_CORE_PROPERTY_LABEL` name it.
- `CLEANER_CORE_PROPERTY_COUNT` is the account's number of properties, so the
  desk knows when to name the property (section 3).

The three new names join `PER_TENANT_NAMES`.

## 2. Migration

Runs once at startup, before any request is served, when `tenants.json` is
older than version 3.

| Tenant today | Becomes |
| --- | --- |
| `cleaning` | one property with cleaning on, and supplies on when `tenant.supplies` was set |
| `supplies` | one property with supplies on |
| no service yet | an account with no properties |
| `touring` | unchanged: `service: "touring"`, no properties, files where they are |

- The property's label is the saved address from `cleaner-live.json` or the
  property name from `supply.json`, else the account label.
- The property id is derived from the tenant id (`prp_` + the tenant id's 10
  characters), so a migration interrupted by a crash finds the same folder
  again.
- Each per-property file or folder that exists in the account folder is
  renamed into `properties/<pid>/` (same volume, so each rename is atomic).
  One that already sits in the property folder is skipped. Only after every
  tenant's files are moved is `tenants.json` written as version 3.
- A crash at any point leaves version 2 in `tenants.json`, and the next start
  runs the migration again and finishes it.
- If the migration can't finish (a rename fails for any reason but "already
  moved"), the service logs the tenant and the file and refuses to start. It
  never serves a half-moved account.
- The migrated property gets `legacyPaths: true`. Every link already handed
  out keeps working: the group webhooks Twilio holds on live conversations,
  status callbacks, upload pages and photo links under `/t/<id>/`.

The in-process desk caches are keyed by folder, so the migration runs before
any desk opens.

## 3. Texts on the shared line

### Which property a text is for

1. **Group texts, status callbacks, upload pages and photo links** come in on
   a property's own path: `/t/<id>/…` for the legacy property, or
   `/t/<id>/p/<pid>/…`. Each group conversation's webhook is built from its
   property's `PUBLIC_BASE_URL`, so the path names the property. A path whose
   property doesn't exist, or whose flow is off (cleaning for Cleaner Core's
   paths, supplies for Supply Core's calendar upload), gets the same answer a
   turned-off tenant gets today.
2. **One-to-one texts** to `/webhooks/twilio/cleaner-core` find the account
   by the `To` number, then the property by the sender:

| Sender | Account with 1 property | Account with 2+ properties |
| --- | --- | --- |
| The landlord: the host on any of the account's properties | that property, as today | **STOP / START** (and the carrier synonyms): applied on every property where they're the host. **Anything else**: nothing changes, one reply "Please tell me in your agent chat so I know which property." at most once every 12 hours, and the agent's alert says the text wasn't used. **HELP**: no reply from this code, as today. |
| A cleaner or contact on one property | that property | that property |
| Nobody on the account | that property, as today (the desk treats an unknown sender as it does now) | nothing sent, logged. STOP is recorded for the account. |

The Twilio signature is checked before any of this, as today, so a forged
STOP changes nothing.

### The account's line opt-outs

An unknown sender's STOP on a two-property account is kept in the account
folder. When that phone is later saved as a person on any property, the desk
starts it opted out, and it has to send START or YES first. START from that
phone clears it.

### One property per person

Until #165:

- A phone can be the cleaner or a contact on only one of the account's
  properties.
- The landlord's phone may be the host on every property, but can't be a
  cleaner or contact anywhere on the account.

`LiveDesk` takes one optional hook from the hosted layer, `phoneElsewhere(phone)`,
which names the other property using that phone, if any. The people and
contact saves call it before saving. The refusal goes only to the agent:
"That number is already on 12 Scratch Lane. For now one person can be on
only one property." Nobody is texted.

Because people never overlap between properties, every desk texts only its
own people, and no text to a cleaner can carry another property's name or
address.

### Texts to the landlord

With `CLEANER_CORE_PROPERTY_COUNT` 2 or more, every text from a desk to the
landlord starts with the property's label, and every alert to the agent
carries the property's id and label. With one property, texts read as today.

### Twilio check before a live second property

The landlord in two group conversations on one line, each with a different
cleaner. A group conversation is identified by its full set of members, so
this should be allowed. It is proved on a Scratch tenant with Saad's okay
(`AGENTS.md`) before any live account adds a second property. If Twilio
refuses, that property's group falls back as it does today on a refused
group (`GroupNotConfirmed`, no door code sent), and the agent is told.

## 4. What the agent sees

### Account tools

These replace `choose_service`, `switch_service` and `stand_down_service`:

- **`get_state`** lists the properties, the flows on for each, and each
  property's next step. With no properties it asks for the first one. With
  one property it reads as today's `get_state` for its flows.
- **`add_property { label }`** creates a property with every flow off. It
  texts nobody and needs no approval. Its folder is created, and its desk
  starts with the account's connected alert routine (below).
- **`set_flows { property, cleaning?, supplies?, fixer?, confirmation? }`**
  - Turning a flow on takes effect at once and starts that flow's setup.
    Nothing is texted before that flow's Activate, as today.
  - Turning a flow off, with something live, is a two-call approval like
    today's stand-down. The first call previews what's live and the exact
    texts that would go out, with a code. The second call, with the code,
    stands the flow down: no new offers, no door code sent, open carts
    closed. Then the flow is off. With nothing live, one call turns it off.
    The setup is kept, so turning the flow on again picks it up.
  - Approval codes use the persisted `ConfirmationBook` in the property
    folder (#167).
  - `fixer: true` is refused: "Fixer Core isn't available yet."

### Property tools

- Every Cleaner Core and Supply Core tool gets a `property` argument. The
  front takes it out of the arguments and hands the call to that property's
  desk, unchanged.
- `property` is required once the account has two or more properties.
  Without it the refusal lists the properties by id and label. With one
  property it's optional, so a live chat that has never heard of properties
  keeps working.
- A property whose flow is off is refused: "Cleaner Core isn't on for
  8 Scratch Court."
- The tool list is every tool of any flow that's on for at least one of the
  account's properties, plus the account tools. Supply Core stays Grok-only
  until #168.
- Supply Core's property and turnovers come from Cleaner Core when cleaning is
  on for the same property, and from its own calendars otherwise, as a
  standalone Supply Core today. #165 merges the two.
- The scratch tools (`reset_scratch` and the rest) take `property` too.

### Instructions

The server's instructions and the bootstraps (`CLEANER_CORE_BOOTSTRAP.md`,
`SUPPLY_CORE_BOOTSTRAP.md`, `cleaner-template/`, `supply-template/`,
`muse-template/`) say: call `get_state` first, name the property in every
property tool call, and use `set_flows` to turn a flow on or off.

### Touring

New accounts aren't offered touring. An existing touring account keeps its
touring tools and its process. Only `/admin` sets an account to touring.
Touring tests set it up through the registry or `/admin`.

## 5. Account-wide pieces and background work

- **Connections, the primary chat, alert routines.** The routine belongs to a
  connection, saved per account in `secrets.json`, as today. Each property's
  desk keeps its own alert outbox, and all of them deliver to the primary
  chat's routine. When a routine is connected through one property, the
  hosted layer marks it connected on every property of the account, and a new
  property starts that way, so setup never asks again. `promoteRoutineOwner`
  reads the connections across all the account's properties.
- **Drains and checks.** `drainAllTenants` walks every enabled account, then
  every property with cleaning on. One property's failure never stops the
  rest. Scheduled checks and Supply Core's runs go property by property in the
  same way.
- **/admin.** Shows each account's properties and their flows, with a health
  line per property. It can turn a flow off with force, which sends nothing.
  Turning an account off stops every property. Deleting it removes the folder,
  properties included. The export is the account folder, properties included.
  The page still never shows a door code, a calendar link, a routine key or a
  cleaner's phone.

## 6. Errors

- The migration can't finish: logged with the tenant and file; the service
  doesn't start; `tenants.json` stays version 2 and the next start tries
  again.
- Unknown or removed property id: refused, with the account's properties
  listed.
- A flow turned off while a call for it is under way: the desk's own checks
  refuse, as for a turned-off tenant today.
- A text to a property path whose property is gone: the same answer as for a
  turned-off tenant; nothing is sent.

## 7. Testing

All tests use 555 numbers only, made-up door codes, and fake Twilio clients.

- **Migration:** each kind of v2 tenant migrates to the table in section 2. A
  crash between two renames, then a restart, finishes the job. A v2 cleaning
  tenant's sealed door code, group conversation webhook path, upload link and
  pending approval all work after the migration.
- **Two properties, one account (the issue's done-when):** Cleaner Core and
  Supply Core on two properties at once, each with its own cleaner, each set
  up through the `property` argument, to a turnover with the door code
  released after the host says the guests left, and a supply reorder.
- **Tools:** a call without `property` is refused once there are two. A
  property whose flow is off is refused. A one-property account's chat works
  without the argument. `set_flows` off with a live job previews it, needs the
  code, and a wrong or expired code changes and sends nothing.
- **Routing:** each cleaner's YES, DONE and STOP reach only their own
  property. The landlord's STOP reaches both properties. A landlord's
  one-to-one departure text on a two-property account releases nothing and
  gets the one reply. An unknown sender gets nothing, and their STOP holds when
  the phone is later added. Saving one property's cleaner on the other is
  refused. No text to a cleaner contains the other property's label or
  address.
- **Gates:** `docs/cleaner-core-safety-gates.md` and
  `docs/supply-core-safety-gates.md` stay green, with a new Cleaner Core gate
  row: "A cleaner gets texts about their own property only", pointing at the
  routing test.
- The full suite stays green, touring included. The verify-cleanercore doctor
  and smoke runs match their expected output.
