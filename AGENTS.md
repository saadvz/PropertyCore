# Agent safety

Cloud agents load this file at the start of a run.

This repository is Property Core: start at [README.md](README.md). For property setup or a host's question, read [CLEANER_CORE_BOOTSTRAP.md](CLEANER_CORE_BOOTSTRAP.md) and [SUPPLY_CORE_BOOTSTRAP.md](SUPPLY_CORE_BOOTSTRAP.md). Tour Core is parked: its guide is [docs/tour-core/README.md](docs/tour-core/README.md), and its setup and operator skills stay in [GROK_BOOTSTRAP.md](GROK_BOOTSTRAP.md) and [.grok/skills/](.grok/skills/). Read those only for a tour.

## Safety rules

An agent sends no live text to a real person without Saad's okay. That holds even though Cleaner Core itself may text anyone the host saved in setup, once the host's phone is confirmed and that person replied YES.

Tests and Scratch runs use only 555 numbers. Saad's own phones and the Twilio number are never test targets.

Door codes in this repo are made-up. A real lock code stays out of tests, fixtures, logs, and prompts.

The door code goes only to the approved cleaner: in the group when it holds only the landlord and the approved cleaner, or as the landlord chose when the group holds anyone else. The proof for that gate is [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md).

Secrets stay out of code, logs, and prompts. [GROK_BOOTSTRAP.md](GROK_BOOTSTRAP.md) already says not to ask for a secret in chat, and not to repeat one if someone pastes it.

Cory (the host) never texts the Cleaner Core number.

## How to verify a change

Prove a Cleaner Core change with the [verify-cleanercore skill](.cursor/skills/verify-cleanercore/SKILL.md). The gates that have to stay green are [docs/cleaner-core-safety-gates.md](docs/cleaner-core-safety-gates.md). The skill sends nothing to a real phone. Before a live run, follow that skill's [preflight](.cursor/skills/verify-cleanercore/SKILL.md#preflight).

## Lessons

At most eight one-line notes. A note with a test links to that test.

- 2026-10-14: `noteUnsentHost` records a declined host text as unsent (#99). [test/cleanerHostTexts.test.ts](test/cleanerHostTexts.test.ts)

## Upkeep

Cloud agents never edit this file on their own. A change comes only through a proposed pull request that QA bot reviews. Delete a lesson once a test enforces it.
