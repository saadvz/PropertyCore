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
| **Fixer Core** | Repairs and upkeep: the host's preferred pros asked first, a shortlist, booking, access for the visit, and the cost logged. | Next |

## Connect your agent

Grok Bot and Muse are the supported agents. Both are always on and run Cleaner Core and Supply Core end to
end. Your agent clones this repository only to read its setup guide, then connects to the hosted service.
Nothing runs on your computer.

When the connection asks for approval, the connect page opens. Where sign-up is open, sign in or create an
account there with a code texted to your phone. Otherwise, type the invite code from Saad. Then click Allow.
Your agent never asks for the code, a password, or a door code in chat.

- **Grok Bot:** add the Cleaner Core team template from its shared link, or paste the prompt in
  [`cleaner-template/SETUP_PROMPT.md`](cleaner-template/SETUP_PROMPT.md) into a new Grok Bot (more in
  [`cleaner-template/`](cleaner-template/)). Then say "Set up Cleaner Core". The bot follows
  [`CLEANER_CORE_BOOTSTRAP.md`](CLEANER_CORE_BOOTSTRAP.md), and turns Supply Core on for a property when you
  ask. For Supply Core on its own, use [`supply-template/`](supply-template/), which follows
  [`SUPPLY_CORE_BOOTSTRAP.md`](SUPPLY_CORE_BOOTSTRAP.md).
- **Muse (beta):** paste the prompt from [`muse-template/`](muse-template/) into a new Muse chat. Muse saves
  the Cleaner Core and Supply Core skills from this repository and follows them.

Claude and ChatGPT, as plain chats, run Cleaner Core at a basic level, without Supply Core. Their guides are in
[`claude-template/`](claude-template/) and [`chatgpt-template/`](chatgpt-template/).
[`docs/client-matrix.md`](docs/client-matrix.md) shows what each agent does differently.

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
| `src/hosted/`, `src/cleaner-core/hosted/`, `src/mcp/` | The hosted multi-tenant service: accounts, text lines, the connect page, and the connector |
| `cleaner-template/`, `supply-template/`, `muse-template/` | The Grok Bot and Muse setup guides |
| `claude-template/`, `chatgpt-template/` | Cleaner Core for Claude and ChatGPT as plain chats |
| `property-core-template/` | One bot for every flow, being updated to become the single way to start |

## Tour Core is parked

This repository started as Tour Core, a self-touring tool for rental units. Touring is parked: it stays in the
repository and its tests keep running, but new accounts get properties, not touring. Its guide and brochure
are in [`docs/tour-core/`](docs/tour-core/README.md), which links to its setup files.

## Contributing, security, and license

See [`CONTRIBUTING.md`](CONTRIBUTING.md) to propose a change and [`SECURITY.md`](SECURITY.md) to report a
security flaw privately. Property Core is licensed under the [Apache License 2.0](LICENSE).
