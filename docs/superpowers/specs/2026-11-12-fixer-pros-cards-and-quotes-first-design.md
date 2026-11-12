# Fixer Core: pros in two cards, and "get quotes first"

Status: approved in chat on 2026-11-12.

## Why

Testing Fixer Core setup in Grok Bot showed two gaps.

- The pros card had nine options, and Grok's choice card showed only six. Appliance repair, Locksmith and "None yet" were dropped, so the host had no way to say none.
- The per-repair cost line card offered only "No cost line". The host wants to see prices before choosing a pro or a line.

## Goals

1. **Pros in two cards.** The pros step asks two choice cards, each with at most five options:
   - Card 1: Plumber, HVAC, Electrician, Handyman, None of these.
   - Card 2: Gutters, Pest control, Appliance repair, Locksmith, None of these.
   - Grok then asks for a name and phone only for the trades the host picked.
2. **Fixed options on the cost line question.** When a repair starts, the question offers No cost line, Set a cost line (the host types the amount), and Get quotes first.
3. **Get quotes first.**
   - Grok confirms in one line: "I'll call pros for quotes only and report back before anyone is booked. OK?"
   - On yes, the job is saved as quotes-only (`quotesFirst: true` on `open_job`, or on `approve_job` with the host's go).
   - While a job is quotes-only, Grok asks each pro for a price, not a time. `record_contact` with `booked` is refused. A time the pro offers is logged with the quote as its note, and Grok tells the pro it will call back.
   - Once every pro contacted on the job has an outcome (quoted, declined or no answer), and none is still waiting or unanswered, `check_fixes` gives `quotesReady`, once per job: the job, its quotes (pro, amount, note), and a question.
     - With quotes: "Quotes for {what}: {Pro} {$}, … Who should I book, and want a cost line?"
     - With none: "No quotes yet for {what}. Want me to find more pros?"
   - New tool `pick_quote` takes `{ jobId, proId, costLineCents?, confirmation }` and needs two calls with the host's yes. It ends quotes-only, saves the cost line on the job, and makes the chosen pro `contactNext`'s first pro. Booking then goes the normal way and still needs the host's yes.
4. **Adding a cost line later.** `pick_quote` is the only way to add a cost line after a repair starts. It works only on a quotes-only job.

## Non-goals

- No message per quote: the host hears once, in the summary.
- No cost line edits on jobs that aren't quotes-only.
- No change to the booking gates.

## Approaches

| Approach | What it means | Result |
| --- | --- | --- |
| Quotes-only flag on the job, summary in `check_fixes`, and `pick_quote` | Fixer Core holds the rule and the summary | **Chosen** |
| Guide-only: tell Grok to ask for quotes and not book | Nothing in code holds the rule | Rejected: the agent's words alone can't hold it, and the repo's gates hold rules in code |
| Report each quote as news | One message per quote | Rejected: more pings; the host asked to hear back once |

## Left to the builder

- Wording of the guide lines.
- Field names inside `quotesReady`.
- Where the job remembers that its summary was given.
