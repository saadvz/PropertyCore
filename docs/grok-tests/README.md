# Grok live test scripts

One file per feature, named `<issue or PR number>-<short-name>.md`. A Claude session runs a file in the real Grok
Bot app with the [grok-live-test skill](../../.claude/skills/grok-live-test/SKILL.md). A person can run the same
file by hand. The design is [2026-11-22-grok-live-test-design.md](../superpowers/specs/2026-11-22-grok-live-test-design.md).

To start a run, ask in the project: "Run the Grok tests for #280".

## Format

```
# Locks and who comes in (#280)

Property: Adélie Cottage

## 1. Who came in

Say: "Who came in today?"
Expect: Grok names the unlock and how it happened. No code digits and no full phone number.
Check: none
Wait: none
```

- `Property:` is `12 Scratch Lane` (anything about texts) or `Adélie Cottage` (locks, guest codes, visits).
- Each step is `## <n>. <title>` with four lines:
  - `Say:` a quoted host line typed exactly, `press <letter> on the card`, or an action in Chrome that starts with
    "in", such as `in the Seam console, unlock the Front door`.
  - `Expect:` what Grok's reply means. Exact words only when quoted.
  - `Check:` where to look outside the chat, or `none`.
  - `Wait:` `none`, a duration (`15 minutes`), or a clock time (`5:15 PM`).
- On 12 Scratch Lane, every quoted Say line starts with "On 12 Scratch Lane only:".
- A `## Still by hand` section at the end lists what the file leaves to a person.

`test/grokTestScripts.test.ts` checks every file here: each step has all four lines, every phone number is a 555
test number, no line holds door code digits, and Scratch steps name the property.
