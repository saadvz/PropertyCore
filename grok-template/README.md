# Tour Core Grok Bot template (v0.5.0)

> **Tour Core is parked.** New hosts start from
> [`property-core-template/`](../property-core-template/README.md), which sets
> up Cleaner Core and Supply Core. This folder stays for touring accounts,
> which only Saad makes, and for the files `GROK_BOOTSTRAP.md` and the
> installer read. Touring's guide is
> [`docs/tour-core/README.md`](../docs/tour-core/README.md).

Everything that belongs in the **Tour Core** Grok Bot team template, versioned
with the code. Grok Bot is the installer and operator console; Tour Core stays
the system of record and policy authority. A door access provider carries out
the access Tour Core approves.

```
Operator ─► Tour Core Bot ─► hosted Tour Core (hostedTourCoreUrl) ─► door access
               │
               └─ open-source fallback: clone and run Tour Core on the
                  Bot's computer (npm run bootstrap:grok)
```

First run: the operator says **"Set up Tour Core."** When `hostedTourCoreUrl`
is set, the Bot connects to that service. It does not ask the operator to
host anything. See [`docs/deployment.md`](../docs/deployment.md).

Two ways in:

- **Final template experience:** add the Tour Core Bot from the template and
  say *"Set up Tour Core."* The template already knows the canonical
  repository and the bootstrap behavior.
- **Development / open-source fallback:** a completely blank Grok Bot, one
  prompt with the repository URL, no attachments. Grok clones the repository
  and follows [`GROK_BOOTSTRAP.md`](../GROK_BOOTSTRAP.md), which points it to
  the skills in `.grok/skills/`. The files in this folder aren't needed for
  that path. The prompt is in [`docs/grok-manual-test.md`](../docs/grok-manual-test.md), test B.

## What's in the template

| Part | File(s) | How it gets into Grok Bot |
| --- | --- | --- |
| Profile (name, title, description, standing instructions, starting prompts) | `bot-profile.md` | Bot actions → Edit Profile, and the Bot's instructions |
| Reusable context | `context/*.md` | Attach or paste into the Bot conversation and ask it to remember them |
| Seven skills: Install Tour Core, Setup Property, Map Route, Run Readiness Check, Work Exception, Export Audit, and Backup Tour Core | `../.grok/skills/*/SKILL.md` (canonical, not copied) | Ask the Bot to save each as a private skill |
| Routine: Tour Core Operator Updates | `routines/operator-updates.md` | Grok creates it (authenticated webhook trigger, these instructions) when the operator turns on tour updates |
| Safe examples | `examples/*.md` | Context for the Bot; made-up data only |
| Integration | `integrations/tour-core-tools.md` | Custom MCP server; connected by every installation |
| Manifest | `template.json` | For reviewers; lists every item, the repository setting, and what's never included |

`SETUP_PROMPT.md` is this template's copy-paste Grok Bot prompt. The Tour Core guide's copy, in
[`docs/tour-core/README.md`](../docs/tour-core/README.md#set-up-with-grok-bot), reads a little differently.
Do not change a word. Hosted storage-health guidance (`persistentVolume: false`
means attach a volume; never use the ephemeral-storage escape hatch on a live
service) is in `context/installation.md`, `integrations/tour-core-tools.md`,
and the Install Tour Core skill.

The repository address is https://github.com/saadvz/TourCore
(`template.json` → `repository.url`). An address in the operator's message or
`TOURCORE_REPO_URL` is only a fallback: if it differs, Grok asks the operator,
and `npm run bootstrap:grok` refuses to start a clone from another origin.

## What's never in the template

Sendblue keys or secrets, the webhook secret, the Grok Routine's webhook
address or key, Tour Core connector or OAuth tokens, door access credentials,
visitor names or phone numbers, live property records, tour history, any
canonical Tour Core state, or a private repository address.
`test/grokTemplate.test.ts` fails if any of these patterns show up in this
folder or the skills.

Custom MCP servers and credentials don't travel with a Grok Bot template.
After adding the Bot, each installation gets its own Tour Core, its own
connection, and its own routine credentials (collected with a secure secret
input). `template.json` → `marketplace` spells out what ships
(instructions, skills, the routine definition, integration references) and
what never does.

## What the Bot does for the operator

- **Property identity and type.** The address is the property's name unless
  the operator gives one; the Bot never invents a building name. A missing
  street, state, city, or ZIP is asked one at a time, state before city, and
  every part already given is kept. It asks
  "What type of property is this?" (single-family home; multifamily — duplex
  or small building they own; apartment or condo — one unit) and shapes the
  units question to match. On a fresh install it asks "How should people text you about a tour?"
  and calls `set_up_texting`. Once texting is installed, a new
  property uses that texting automatically and is not asked again.
- **Tour updates.** After the first property, the Bot offers to keep the
  operator posted on bookings, tour starts, completions and anything that
  needs their input, through the Tour Core Operator Updates routine.
- **Plain status.** "Visitor texting is live. Door access is still in demo
  mode, so no physical locks will open." Never "everything runs in demo mode".
- **Visitor questions at every stage.** Answered only from approved facts;
  anything unknown is flagged to the operator, and the visitor picks up where
  they left off once it's answered. A bare `cancel` is the carrier opt-out. On a booked tour that has not started it also cancels the tour, frees the slot and door access, alerts the team, and sends `Your tour is cancelled and you won't get any more texts from us. To come back or book again, reply START.` While they are touring, a bare cancel stays a cancel. Other booked-tour cancel phrasing is handled by Tour Core: it confirms, then YES cancels (`You're
  cancelled. Text me anytime if you want to book again.`) or NO keeps the
  booking (`Okay, your {time} tour on {day} stays booked.`). While they are
  touring and the cancel targets a later booking: `Cancel your later tour at
  {time} on {day}? Your tour right now isn't affected. Reply YES or NO.`;
  YES `Done, I've cancelled your later tour at {time} on {day}. Your tour
  right now isn't affected.`; NO `Okay, your later tour at {time} on {day}
  stays booked.` If they name the tour they are on: `You can't cancel the
  tour you're on, but you're free to wrap up whenever you like. Your later
  tour at {time} on {day} is still booked. Want me to cancel that one
  instead? Reply YES or NO.` A touring visitor with no later booking who
  texts cancel hears `You can't cancel the tour you're on, but you're free
  to wrap up whenever you like. Text me anytime if you want to book another
  tour.` On hold or a door-system problem those refusal lines insert
  `The {team} is still working on the problem and will text you here.`
  after the first sentence. A reply that isn't a
  clear yes or no is flagged. That is not a missing-fact flag. When nothing
  is booked yet, that same cancel phrasing at the day menu, the time menu, or
  the property picker (a bare cancel is still STOP) clears the step and
  replies `No problem, nothing's booked yet, so I'll stop here. Text me
  anytime if you want to pick a time.` The next text from someone already
  opted in starts scheduling again, with no TOUR keyword. At the property
  picker, that next text asks which place again.
- **One-off tours.** When the operator wants to set up a tour for someone who
  asked (including a visitor who hasn't texted in, or who only got a day or
  time menu and never booked), the Bot uses `schedule_tour` and asks
  the exact question Tour Core returns. Only a yes that they asked is enough.
  A leftover choosing menu is replaced; a booked tour, pending one-off, open
  tour window, or hold is refused. A time that overlaps a running tour or any
  future or held booking is refused before asking. `schedule_tour` will not
  move a tour in progress, including hold or a door-system problem (`{who} is touring right now, so I can't move this
  tour. Once it ends, you can book them another time.`); if they have a later
  booking it asks `Want me to move their {oldTime} on {oldDay} booking to
  {newTime} on {newDay} instead?` (outside hours: `{who} is touring right
  now, so I can't move this tour. Their later booking is {oldTime} on
  {oldDay}, and {newTime} on {newDay} is outside your tour hours. Want me
  to move it there anyway?`) and a yes is `Moved {who}'s later booking
  to {time} on {day}.`.
  Tell the operator Tour Core's words
  (`They already have a booked tour. I can move it or call it off.`), then
  move with `schedule_tour` or call off with `cancel_tour` (resume a
  hold with `hold_tour`). If tours are paused, approve and
  reschedule refuse (`Tours at {property} are paused. Resume them first.`).
  After resume, a visitor Tour / Hi / book restarts booking the same way as a
  first text.
  While the visitor is confirming, a leftover
  menu number only re-prompts YES / NO / STOP; a real question is flagged.
  Tour-time confirmation questions end `Move it?` or `Book it?`.
  A save asks `Send this to {who} and save it for anyone who asks the same thing later? "{exact visitor text}"`.

Install and publishing steps: [`docs/grok-template-setup.md`](../docs/grok-template-setup.md).
Manual test: [`docs/grok-manual-test.md`](../docs/grok-manual-test.md).
