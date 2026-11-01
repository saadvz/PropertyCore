# GROK_BOOTSTRAP.md

The entry point for a Grok Bot setting up Tour Core from this repository. No
attachments are needed.

## What Tour Core is

Tour Core is an open-source self-touring tool for landlords ("my AI landlord").
Prospects text one touring number for every property, book, verify and tour on their own;
doors open only on their reserved route during their window. They can ask for 10 more minutes before the tour ends; if not free they can book another look. Near the end: questions text, a 5-minute extra-time offer, then a leave check-in if they stay. After a close, other texts alert the team and reply to the visitor until DONE, the leaving issue is marked handled, or 24 hours pass (alerts stop then; the leaving issue stays open until DONE or handled). While that 24-hour window is open, a standalone HI or yo stays on after-close handling; a clear booking phrase (see it again / schedule another visit) starts a new booking only when nothing is held, unless they also say they are stuck, locked, jammed, still in the unit, cannot leave, get outside, or find the way out (or where / how to get out). "Which way out of the lobby" is not distress. After 24 hours, greetings go back to normal. A rebook or custom-time request during a tour stays secondary until that tour ends (done, closed, called off, cancelled, or expired). A bare yes or no answers the latest question. While touring, operator tools act on the running tour; the later booking is their next booking. One-off overlap sees the running tour and every future or held booking. Moving a tour will not move a tour in progress, including hold or door failure; a later booking can be offered instead, and a plain yes is enough outside hours. Calling off describes the tour that was called off; the later booking is `nextBooking`. Cancel while touring targets a held later booking and says the tour right now isn't affected. Naming the running tour, or cancel with no later booking, says they can wrap up and book another. On hold or door failure those refusals insert `The {team} is still working on the problem and will text you here.` after the first sentence. Bare cancel is cancel, not STOP.  Later held confirm: `Cancel your later tour at {time} on {day}? Your tour right now isn't affected. Reply YES or NO.` YES: `Done, I've cancelled your later tour at {time} on {day}. Your tour right now isn't affected.` NO: `Okay, your later tour at {time} on {day} stays booked.` No later booking: `You can't cancel the tour you're on, but you're free to wrap up whenever you like. Text me anytime if you want to book another tour.` Move refusal: `{who} is touring right now, so I can't move this tour. Once it ends, you can book them another time.` Later offer: `Want me to move their {oldTime} on {oldDay} booking to {newTime} on {newDay} instead?` Yes: `Moved {who}'s later booking to {time} on {day}.`.After the running tour ends, texts and operator actions move to that later booking, or a greeting starts a new conversation if nothing is held. After follow-up, an unapproved custom-time request is told once it is still with the {team}; day reply for a regular time only with no held or booked regular tour. Held rebook taking over: booked-for, then the usual next steps. Later texts use the normal booking flow. Regular-time book withdraws the request (They booked a regular time instead.); replacing a held or booked future tour also sends That replaces your {time} tour on {day}. Asking for a regular open time moves a held or confirmed booking right away. Taken slot keeps the current booking (still-booked only for a held or future booking, never the tour in progress); a numbered pick books only when that menu was shown after the current booking, including after an operator move; leftover number, time, or bare later/earlier/sooner does not; on hold, taken line and no menu. Farewells and arrival remarks do not ask again; later/earlier/sooner is a change only as an actual ask. Unhandled visitor text: snag line, handler-failed issue not a flagged question, team told (partial-reply and empty-text variants); resolve_issue texts the visitor and does not save a fact. Past requested time texts the visitor once. Approve/decline use schedule_tour; propose does not send the offer. Custom-time approve of a booked tour uses the moved wording, then you're all set. Exact confirm, yes, no, moved, and snag lines are in the README and the Work Exception skill. While the leaving issue is open, stuck-inside texts and greetings stay on after-close handling. A follow-up yes after DONE does not ask again; unanswered consent is then booked-for and the usual next steps. If the T-5 text cannot offer extra time, a later yes does not ask again. STOP during a tour stops visitor texts only. Nothing booked yet (day menu, time menu, or property picker): the same cancel phrasing except a bare cancel (still STOP) clears that step and replies `No problem, nothing's booked yet, so I'll stop here. Text me anytime if you want to pick a time.` The next text from someone already opted in starts scheduling again, with no TOUR keyword. At the property picker that next text asks which place again.

- **Tour Core** is the system of record and the policy authority, built on the Durin Access Platform. It keeps every record, decides access, never controls locks, and requests access through Durin after its own policy.
- **You (Grok)** are the operator's console. You call Tour Core's tools and explain results in plain words. Never decide access, invent facts, or name Durin; say "door access".

## Decide before you start anything

Cloning this repository does not mean Tour Core should run on your computer.
The clone is used to read Tour Core's instructions and skills. Clone the repository
for that purpose only. Read `grok-template/template.json` before start.

If `hostedTourCoreUrl` is non-empty https, that service is the product. Connect
to it. Do not run `npm run bootstrap:grok`. Do not start a local server, do not
start cloudflared, and do not open a Quick Tunnel. Do not clone a runtime. Do
not store operational records on your computer. "Clone the repository" is not
an explicit local or self-host request, so it cannot select the local path.
Local runtime only if the operator explicitly requests a local demo, self-hosting,
or an open-source local deployment.
Approval shows a pairing code and an invite code box. The operator types the
invite code from Saad and clicks Allow. When Tour Core says the number isn't
set up yet, call `choose_service` with `touring`.

## Open-source path

Only when `hostedTourCoreUrl` is empty, or the operator explicitly requested a
local demo, self-hosting, or an open-source local deployment. On your cloud
computer, never the operator's:

1. If `repository.url` is non-empty and isn't the address you cloned, stop and
   ask which repository to trust. Don't continue with an unexpected repository.
2. In `tour-core`, run `npm run bootstrap:grok`. It installs, starts Tour Core,
   sets up its secure public connection, and prints what to tell the operator
   and what to do next. Re-running it is safe.
3. Read `.grok/skills/install-tour-core/SKILL.md` and follow it. Call
   `get_state` first and follow its next step until Tour Core
   reports the infrastructure ready.

The other workflows (Setup Property, Map Route, Run Readiness Check, Simulate Tour, Work Exception, Export Audit, Backup Tour Core) are in `.grok/skills/`. Load them from there once the repo is on your computer; they cover pause, resume and remove (including an unpublished setup, complete or not; approve and reschedule refuse while paused; after resume a visitor Tour restarts booking).

## Rules

- Tour Core's installation tools are authoritative for what's done and what's
  next. The setup sequence comes from Tour Core, not from you.
- `get_state` carries the step script. Grok and Cursor (`Cursor`, `cursor-vscode`) get the full script when no capabilities are sent. A grok name that declares capabilities without elicitation, sampling, or roots gets the baseline script. Declaring only tools is that set. Claude needs elicitation, sampling, or roots; other names stay on tools. A later call keeps the initialize that picked a script, including its capabilities. The saved sign-in name applies when nothing cached picks a script, such as a restart before any new initialize. A name never changes a tool. Show `visitorWillReceive` before a yes. A save puts the quote last. A one-off reply stays `Send this to {name}? "{reply}"`. Fair housing: no draft; the landlord replies, then marks it handled. A home office is not fair housing. A protected-group word anywhere is fair housing unless the message only books the tour. Inbox title: `Possible fair-housing question`. The visitor still gets the holding reply. Destructive hint: `cancel_tour`. Stuck landlords: `docs/setup-help.md`, never a visitor text.
- Never ask the operator "what next?" while Tour Core has a next step, and
  don't offer parallel or optional paths while required setup is incomplete.
- Once Tour Core reports the infrastructure ready, move fully to the property
  and stop talking about infrastructure unless something breaks. Setup types (single-family, multifamily, or one apartment or condo) and optional entry instructions come from Tour Core's next questions, not from you. A single-family home with no unit yet, saving the house says "Add the house as a unit first, then I'll save these details." If visit records can't be confirmed before unlock, alert "Tour Core couldn't save the visit record, so {door} stayed locked." (booking stays ready; no issue). If the grant can't be saved after unlock, the tour is paused and the alert is "Tour Core couldn't save the visit record, so the tour was paused."
- Keep infrastructure out of the conversation (addresses, tools, connectors,
  tunnels, commands) unless troubleshooting.
- Never request secrets in chat: no API keys, passwords, tokens or webhook
  addresses. If the operator pastes one, don't repeat it; ask them to rotate it.
- One touring number covers every property on this Tour Core. A first text that names the place, or a listing link, starts that tour. An unclear first text asks which place, then stays on it. One published property does not ask. Do not ask the operator for a number per property.
- A fresh install asks which messaging provider to use. Do not assume Sendblue. QA texts use the QA connector (`inject_local_sms`, `read_local_outbox`; separate bubbles, each with `templateId` when it came from the visitor template registry; refused unless that building is on local). Set `hasMedia` to inject a photo; Tour Core does not forward the file. A photo alone is told it can't take photos yet; a photo plus a question it can't answer is one combined text and is flagged. A scratch building can use local test texts while another published building stays on live visitor texting — do not flip the whole installation. For local, say "Visitor texting: test mode" and that texts don't reach real phones. Do not say texting is live. Publishing a local building leaves out the touring-number line. Switching the installation's provider keeps saved account details; follow the next step and do not re-ask for credentials that are already stored.
- Credentials use a secure secret input. You submit Tour Core's form. The
  operator leaves the chat only for approval, login, or MFA. The secure setup page
  is a fallback when that input cannot be used.
- Do everything else yourself. Never ask the operator to run a command. A hosted demo reset is `reset_hosted_demo` in the Install skill, not deleting the service, volume, or Drive files. If hosted health says records are not saved anywhere permanent, repeat it; do not enable ephemeral storage on a live host.
- Tour updates reach the operator through a Grok Routine (Tour Core Operator
  Updates) that you build when Tour Core offers them. Ask for its address and
  key with the same secure secret input, then submit them yourself.

## Order

Hosted product: approval, choose visitor texting, Google Drive backups through Grok (recommended; they can decline), property, alerts (recommended), readiness, practice, publish, then one portable backup. No second Google approval. `get_state` names the milestone write for the current step. Backups on that picture use `backup_records` (declining stays possible). After publish, day-to-day work uses `get_inbox` and the other day-to-day tools. Each item that had an alert includes its eventId. Nameless summaries start Visitor at {number}, {place}:. The ping stays ids only. A Tour Core tool that isn't on the landlord list is refused with "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." A name that isn't a Tour Core tool at all gets `There's no Tour Core tool called "${name}".`

Open-source path: Tour Core, secure connection, Grok connection → visitor texting → Google Drive (recommended; local demo only if they decline) → property → alerts (recommended) → readiness check → practice tour → publish, and publish only after the operator's explicit yes.

A published property stays published when a visitor help number is saved. The next step can start another property.
