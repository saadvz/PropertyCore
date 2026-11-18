# Hours log follow-ups: a record of each host approval, and the agent copy (#238)

Part of #238 (and #236). #247 built the hours log behind `HOURS_LOG=1`. Two of the issue's open items are in this change:

1. A record of each host approval in each flow, so an approval that's replaced before its month is confirmed isn't lost.
2. The agent template copy for the three tools (`review_hours`, `export_hours`, `save_hours_settings`).
3. The log goes wherever the host already keeps spreadsheets, not only Google Sheets (the host's ask on this thread).

Lock-code owner rows (#180), measured visit times (#237), the lock-event check, the host's own activity codes and the tax review stay open on #238.

## Why

The hours log rebuilds every row from the records each flow keeps. That's what keeps rows derived. But some of those records are replaced when the work moves on, and the host's approval goes with them:

| Flow | What replaces the approval |
| --- | --- |
| Fixer Core | Moving a visit (`reschedule_job`) deletes the booking, with its `hostYes` and any approved raised price. A rebook makes a new booking object. A second raised price replaces `revisedQuote` with its `hostYes`. A second quote pick replaces `quotePick`. A cost saved again replaces `cost`. |
| Cleaner Core | A stay whose checkout or check-in date moves clears the host's cleaning times for that field (`clearHostTime`). |
| Supply Core | A held cart the host approved that's never placed leaves nothing: closed with `record_problem`, or expired into an unconfirmed order that's later removed as `not-placed`. |
| Cleaner pay | Nothing. A paid record is never replaced or removed. |

#247 keeps the owner facts with a month when the host confirms it, so a confirmed month never loses them. An approval replaced before the confirm is still lost, and the host's real time is missing from their log.

## Goals

- Every host approval in each flow leaves a record that nothing later replaces.
- The record is saved in the same write as the approval, so one is never saved without the other.
- The hours log reads these records as well as the live ones. Rows that exist today don't change, so a month confirmed under #247 still matches and exports.
- The agents know how to use the three tools, only when the tools are listed.

## Non-goals

- Changing which actions are the owner's, or how their hours are found. `ownerRules.ts` and `OWNER_RULES_VERSION` stay as they are.
- Changing the time of an existing row (a supply approval keeps the order's time).
- Turning `HOURS_LOG` on.

## Anti-goals

- A duplicate owner row for one approval. The live record and the kept one must give the same fact.
- Owner time for something the host didn't do. Only the host's own approvals are recorded.
- A record that grows without end.

## Approaches

1. **Each flow keeps its own record, in its own file (picked by the host).** Fixer keeps a list of the host's steps on each job, Cleaner Core keeps the cleaning times it cleared, and Supply keeps each cart approval. Each is written in the same save as the approval. This is what the #247 design named ("a durable owner-action record in each desk"). It touches three desks, each in a few places.
2. **One shared `owner-actions.json` per property.** Every desk calls one helper after it saves an approval. One format and one file for the hours log, but two saves per approval: a crash between them loses the record, and every desk depends on the hours log's module.
3. **Snapshot on change.** The hours log copies owner facts into `hours.json` whenever a desk saves. It has the coupling of (2) and records rows, not what the host did. Dropped.

## Design

### Fixer Core (`src/fixer-core/store.ts`, `desk.ts`)

`Job.hostSteps?: HostStep[]`, appended, never edited:

```ts
interface HostStep {
  kind: "approve-repair" | "pick-quote" | "approve-booking" | "approve-price" | "record-cost" | "confirm-repair";
  at: string;
  proId?: string; // pick-quote, approve-booking, approve-price
  cents?: number; // approve-price, record-cost
}
```

Written beside the live field, with the same `at` string, in the same `write(file)`:

| Live field | Where | Step |
| --- | --- | --- |
| `hostGo` | `open_job` from the host, `approve_job` | approve-repair |
| `quotePick` | `pick_quote` | pick-quote, with the pro |
| `booking.hostYes` | `approve_booking` | approve-booking, with the pro |
| `revisedQuote.hostYes` | `approve_booking` on a raised price | approve-price, with the pro and the price |
| `cost` by the host | `record_cost`, `record_done` | record-cost, with the amount |
| `done` by the host | `record_done` by the host | confirm-repair |

`reschedules` is already a list that only grows, so it's left as it is. At most 40 steps a job, the oldest dropped first.

### Cleaner Core (`src/cleaner-core/core.ts`)

`Stored.clearedHostFacts?: ClearedHostFact[]`: `HostFact` plus the `checkoutDate` it was for. `clearHostTime` moves each fact it clears (only ones with `at`) into the list before it filters them out. The engine reads none of it back. At most 200, the oldest dropped first.

### Supply Core (`src/supply-core/store.ts`, `desk.ts`)

`SupplyFile.approvals?: CartApproval[]`:

```ts
interface CartApproval {
  id: string;           // "apv_" + 10 characters
  at: string;           // the host's yes on approve_cart
  store: string;
  items: { itemId: string; qty: number }[];
  totalCents: number;
  orderId?: string;     // the order the cart became, when it did
  orderAt?: string;     // that order's `at`
}
```

`approve_cart` adds one and puts its id on the cart (`Cart.approvalId`). When the cart becomes an order (`record_order`, or the sweep turning an expired cart into an unconfirmed order), the approval gets the order's id and time. No cart token is stored. At most 200, the oldest dropped first.

### The hours log (`src/hours-log/sources.ts`)

- **Fixer:** each `hostSteps` entry is the same fact the live field gives: same kind, the job's reference, the same `at`. `rawFacts` already drops a second fact with the same kind, reference and time, so a step whose live field is still there adds nothing, and one whose live field was replaced brings the row back.
- **Cleaner Core:** `readRecords` reads `clearedHostFacts` into `hostTimes`, with the checkout date they were for. Same kind, reference and time as before they were cleared.
- **Supply:** an approval whose order still exists adds nothing: the order's own rows stand, at the order's time, as today. An approval whose order was removed (only an unconfirmed order can be, as `not-placed`) gives back that order's owner fact exactly: kind `approve-order`, reference `Supply Core order {orderId}`, the order's time, and the same task the order gave. So a month confirmed with that fact keeps one row, not two. An approval that never became an order (a cart closed with `record_problem`) is an `approve-order` owner row at the approval's time: "Approved a supply order from {store}: {items}, {total}. It wasn't placed." Reference `Supply Core approval {id}`.

`OWNER_RULES_VERSION` stays 1: no rule changed. A month with no replaced approval has the same rows and fingerprint as before.

### Agent copy

A short hours log section in each Property Core agent's instructions: Grok (`property-core-template/bot-profile.md`), Muse (`property-core-template/muse/skills/property-core/SKILL.md`), Claude (`property-core-template/claude/plugin/skills/property-core/SKILL.md`) and ChatGPT (`property-core-template/chatgpt/SETUP_GUIDE.md`). It applies only when `review_hours` is among the agent's tools, so nothing changes while `HOURS_LOG` is off:

- When the host asks for their hours or a month's log, call `review_hours` with the property and month. Show each log's rows and every line in `needs`, ask its question, and call it again with the code only after their yes.
- Then `export_hours`: write each log, exactly as given, to the spreadsheet the host already uses through one of your connectors: Google Sheets, Excel, or another. With none connected, ask the host where they want the log written. Then call it again with `stored: true`. Don't change the rows.
- `save_hours_settings` only as the host says.
- Never give tax advice, or say what counts toward a tax test.

ChatGPT's guide runs Cleaner Core only, but the tools are listed wherever any flow runs, so its copy is a new short section after Step 3, in the same "ChatGPT's instructions" voice as Step 2.

A test checks each of the four names the three tools, ties them to `review_hours` being listed, and says no tax advice.

### Any spreadsheet, not only Google Sheets

The rows `export_hours` gives are plain text in the host's columns, so nothing about them is tied to Google. The words around them are: the tool descriptions, the `next` lines in `desk.ts`, and the `sheet` setting's help say Google Sheet. They change to "the host's spreadsheet": the agent writes it with whichever spreadsheet connector the host already has (Google Sheets, Excel or another), and asks the host where to write the log when none is connected, then saves the answer with `save_hours_settings`. The `sheet` setting keeps its name, so saved settings still read, and its help says it's the spreadsheet's name or link, in any product. A test checks the tools and the agent copy never tie the export to Google alone. README and `docs/environment-variables.md` say the same.

### When the records are written

Always, whether `HOURS_LOG` is on or off. The records are small, and an approval replaced before the log is turned on would otherwise be lost for good. Each desk reads its file with the new field missing as empty, and Cleaner Core's `Stored` load and save keep `clearedHostFacts`.

## Calls made in writing this up

- The supply fact for a removed order copies that order's fact, so a confirmed month keeps one row.
- The records are written with the flag off too.
- ChatGPT gets its own short section.

## Left to the builder

- The exact wording of the supply row's task and the agent copy (operator-facing copy, flagged for a design pass in the PR).
- The caps (40 steps a job, 200 cleared times, 200 approvals).
