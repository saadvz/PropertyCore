# Feature: supplies

Supply Core on a Cleaner Core property. The cleaner's DONE asks what's running low, their answer becomes a `supply-report` message, and Grok turns it into an order through Supply Core's go/hold check.

## Drive

```
npx tsx .cursor/skills/verify-cleanercore/scripts/prove-supplies.ts .cursor/skills/verify-cleanercore/evidence/supplies/supplies.json
```

## Expected

- `doneText` is `Thanks, cleaning marked done. Anything running low? Reply with what's low, or NONE.`
- `noted` is `Thanks, noted.`
- `report.handled` is `supply-report` and its text names paper towels.
- `notDueBefore` is 0: the item was ordered already, so only the report makes it due.
- `due` lists the item once, with the day before the next cleaning as its deadline.
- `verdict` is `go`, and `order.line` starts `Ordered from Example Mart: Paper towels ×2. $48.00`.
- Every recipient is a Scratch 555 number, and the door code appears nowhere in the evidence.

## Not covered

A real store, Grok's own checkout, Vault, and approval cards. The hands-off probe in `docs/superpowers/specs/2026-11-04-supply-core-design.md` (Part 6) is Saad's to run: it spends real money.
