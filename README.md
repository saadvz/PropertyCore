# Property Core

Property Core runs the day-to-day work of a short-term rental for a host who isn't there. The host talks to
their own agent, Grok Bot or Muse. Property Core gives that agent its instructions, keeps every record, and
holds the guardrails in code: who gets the door code, who gets texted, and go or hold on every supply cart.
The agent's words can't change those decisions.

One account can hold several properties on one text line. Each property turns its flows on or off. The host
works from their agent, and the text line is for the cleaner and the other people the host saves.

## The flows

| Flow | What it does | Status |
| --- | --- | --- |
| **Cleaner Core** | Reads the host's booking calendars and texts the cleaner for each turnover. The cleaner gets the door code only after the host says the guests have left. It collects the cleaning photos and can offer the cleaner's pay as a Venmo link. | Live |
| **Supply Core** | Keeps the property stocked. The host picks each product once. Supply Core says what's due, the agent shops and checks out with its own tools, and Supply Core decides go or hold on every cart, keeps the order log, and enforces the spending caps. It never sees a card number. | Live |
| **Fixer Core** | Repairs and upkeep: the host's preferred pros asked first, a shortlist, booking, access for the visit, and the cost logged. | Built; off until Saad turns it on |

## Connect your agent

Every agent starts in one place: [`property-core-template/`](property-core-template/README.md). Grok Bot
and Muse are the supported agents. Both are always on and run Cleaner Core, Supply Core and Fixer Core end to end. Your
agent clones this repository only to read its setup guide, then connects to the hosted service. Nothing runs
on your computer.

When the connection asks for approval, the connect page opens. Where sign-up is open, sign in or create an
account there with a code texted to your phone. Otherwise, type the invite code from Saad. Then click Allow.
Your agent never asks for the code, a password, or a door code in chat.

- **Grok Bot:** add the Property Core team template from https://x.ai/bot/rfmREJxrfqNuTiOs2VqYQ, or paste
  the prompt in [`property-core-template/SETUP_PROMPT.md`](property-core-template/SETUP_PROMPT.md) into a
  new Grok Bot. Then say "Set up Property Core". The bot adds your property and asks whether you want
  Cleaner Core, Supply Core, or both there.
- **Muse (beta):** paste the prompt in
  [`property-core-template/muse/SETUP_PROMPT.md`](property-core-template/muse/SETUP_PROMPT.md) into a new
  Muse chat. It works the same way.

Claude and ChatGPT, as plain chats, run Cleaner Core at a basic level, without Supply Core: start with
[`property-core-template/claude/`](property-core-template/claude/SETUP_GUIDE.md) or
[`property-core-template/chatgpt/`](property-core-template/chatgpt/SETUP_GUIDE.md).
[`docs/client-matrix.md`](docs/client-matrix.md) shows what each agent does differently.

For each flow, the agent then follows that flow's guide: [`CLEANER_CORE_BOOTSTRAP.md`](CLEANER_CORE_BOOTSTRAP.md)
with [`cleaner-template/`](cleaner-template/), and [`SUPPLY_CORE_BOOTSTRAP.md`](SUPPLY_CORE_BOOTSTRAP.md)
with [`supply-template/`](supply-template/), and [`FIXER_CORE_BOOTSTRAP.md`](FIXER_CORE_BOOTSTRAP.md). On Muse, those are the skills in
[`muse-template/`](muse-template/). These are guides the agent reads, not separate ways to start.

## Safety gates

Each flow lists the rules that must hold before it does anything live, with the tests and proofs that hold
them. CI runs those checks on every pull request.

- **Cleaner Core:** [`docs/cleaner-core-safety-gates.md`](docs/cleaner-core-safety-gates.md). The door code
  goes only to the opted-in approved cleaner (or the group thread, if the host chooses that), after the
  guests have left. Nobody is texted until the host's
  own phone is confirmed. Then each person the host saved gets one opt-in text and nothing more until their
  own YES. STOP always wins.
- **Supply Core:** [`docs/supply-core-safety-gates.md`](docs/supply-core-safety-gates.md). The agent sends
  every cart to `check_cart` before it places the order. Caps and price jumps are decided in code, the
  agent's words can't turn a hold into go, no order is recorded without a go or the host's approval, and no
  tool accepts card details.

- **Fixer Core:** [`docs/fixer-core-safety-gates.md`](docs/fixer-core-safety-gates.md). The agent contacts
  only a pro the host approved. A booking waits for the host's yes, and the door code goes only to the pro's
  own phone for the visit. Nothing is paid or taken by card.

How the hosted service keeps accounts apart is in
[`docs/hosted-multitenancy.md`](docs/hosted-multitenancy.md).

## For developers

Property Core is TypeScript on Node 22.13 or later.

```bash
npm ci
npm run typecheck
npm run build
npm test
```

CI runs the same commands, plus the secret scans, the baseline eval (`npm run test:eval`, see
[`docs/eval.md`](docs/eval.md)), and the Cleaner Core proofs. Tests use made-up stores and 555 phone numbers
only, and never send a real text. Deploying the hosted service is covered in
[`docs/deployment.md`](docs/deployment.md#multi-tenant-cleaner-core-one-service-many-hosts). The main
settings are in [`docs/environment-variables.md`](docs/environment-variables.md), and
[`.env.example`](.env.example) lists the developer values.

| Folder | What's in it |
| --- | --- |
| `src/hub/` | The property hub every flow reads: properties, booking calendars, door access, and people |
| `src/cleaner-core/` | Cleaner Core: turnovers, texts to the cleaner, door codes, photos, and pay |
| `src/supply-core/` | Supply Core: the list, schedules, the cart check, and the order log |
| `src/fixer-core/` | Fixer Core: pros, repair jobs, the booking check, visit pages, and the cost log |
| `src/hosted/`, `src/cleaner-core/hosted/`, `src/mcp/` | The hosted multi-tenant service: accounts, text lines, the connect page, and the connector |
| `property-core-template/` | The one way to start: the Grok bot, and its Muse, Claude, and ChatGPT versions |
| `cleaner-template/`, `supply-template/`, `muse-template/` | The Cleaner Core and Supply Core guides and routines that Grok Bot and Muse read |
| `claude-template/`, `chatgpt-template/` | The Cleaner Core guides that Claude and ChatGPT read as plain chats |

## Tour Core is parked

This repository started as Tour Core, a self-touring tool for rental units, and was renamed from
`saadvz/TourCore` to `saadvz/PropertyCore`. GitHub forwards the old address, and a clone made before the rename
keeps working. Touring is parked: it stays in the
repository and its tests keep running, but new accounts get properties, not touring. Its guide is
in [`docs/tour-core/`](docs/tour-core/README.md), which links to its setup files.

## Contributing, security, and license

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to propose a change and [`SECURITY.md`](SECURITY.md) to report a
security flaw privately. Property Core is licensed under the [Apache License 2.0](LICENSE).
