---
name: install-tour-core
description: Connect an operator to Tour Core and take them from a blank setup to a published property by following Tour Core's own next steps, asking only for approvals, logins, credentials through a secure handoff, property information and decisions.
when-to-use: "set up Tour Core", "install Tour Core", "what's left to set up", "check my Tour Core installation", "is Tour Core running", "restart Tour Core", "test alerts", "connect texting", "turn on alerts", "tour updates", "change my notifications", "reset Tour Core", "fresh demo", "fresh onboarding test"
allowed-tools: get_state set_up_texting save_property save_units save_doors_and_routes save_hours save_facts save_settings run_checks publish backup_records restore_records reset_hosted_demo get_inbox remove_property pause_tours get_tours schedule_tour cancel_tour hold_tour reply_to_time_request resolve_issue export_records
argument-hint: "[what to check or connect]"
user-invocable: true
metadata:
  author: Tour Core
  short-description: Connect to Tour Core and guide onboarding, in Tour Core's order
  version: "0.7.3"
---

# Install Tour Core

Call only the landlord tools in allowed-tools. `reset_hosted_demo` is for the hosted owner.

Call `get_state` first and follow its next step. Tour Core decides the order
and tells you, one step at a time, through `get_state` as
well. The backups step on `get_state` is `backup_records`, and declining stays
possible. `get_state` names `backup_records` for that step.
After publish, day-to-day work starts at `get_inbox`. The operator only approves, signs in, gives
credentials through a secure handoff, gives property information and makes
decisions.

## Playbook

`initialize` returns a short instructions pointer. `get_state` returns the
playbook for this step. A client name containing `grok`, or Cursor
(`Cursor`, `cursor-vscode`), gets the full Grok playbook, including the
masked card, even when no capabilities are sent. A declared capability set
that does not include `elicitation`, `sampling`, or `roots` does not unlock
it. That client gets the baseline. Declaring only tools is that set. `prompts` and `resources`
do not pick the playbook. Those two are server capabilities, so a real
client does not report them. Claude is full only with `elicitation`,
`sampling`, or `roots`. ChatGPT and any other name are tools-only. The name
never changes a tool or a gate. Tour Core remembers the initialize per session
or signed-in caller. On a call after initialize, that cached initialize wins
when its name selects a playbook, capabilities included. The stored OAuth
name is used only when the cache is missing, nameless, or baseline. After a
restart, with no new initialize, that stored name still applies, and a
baseline entry cannot override it. Matched
names already used here are `Grok`, `grok`, `grok-bot`, `grok-sim`,
`Grok (SDK test)`, and `Cursor`.

Before a flagged answer is sent, read `visitorWillReceive` and wait for a
clear yes. That is the exact visitor text, including any closing line.
Saving asks `Send this to {name} and save it for anyone who asks the same thing later? "{visitorWillReceive}"`.
The quoted half equals that text byte for byte. A handler-failed reply saves
nothing, so it stays `Send this to {who}? "{reply}"`. A fair-housing flag has
`proposeDraft` false. The refusal is `This one touches on fair housing, so I won't draft an answer. Reply to them yourself, then mark it handled.`
`get_inbox` titles it `Possible fair-housing question`. The inbox summary is `They asked: "{question}"` plus a period when the question does not already end with `.`, `?`, or `!`, then `This may touch on fair housing, so there's no draft. Only you can answer this one. They were told you'd text them back here.` The next step is `Mark it handled once you've replied.` That sentence is not repeated.
and `Mark it handled once you've replied.` After that no-draft flag is saved, the visitor gets `Good question for the {team}. I've passed it along, and they'll text you back here.` They never hear fair housing. If the flag cannot be saved, the team is texted first. The visitor gets `I can't open the doors for you right now. I've let the {team} know, and they'll text you here shortly.` only if that text went out, and `Sorry, I hit a snag with that. Could you text me again in a few minutes?` otherwise. When that team text does not go out, the landlord sees `I couldn't text you about {who}, so I asked them to text me again in a few minutes.`

Tour updates: ask only "Want me to text you when someone books, starts, or
finishes a tour, and ping you the moment something needs you?" One alert
address per install. A new save replaces the old one.

Tool annotations are hints. `cancel_tour`, `restore_records`, and removing a
property are destructive. The older revoke-a-tour and import-a-backup tools
stay destructive, along with disconnecting Drive storage and taking over the
storage writer. The hidden hosted reset is also marked destructive.

If a step keeps failing, give the landlord the setup help link as one plain
link. Never put that link in a text to a visitor.

Deployment is fixed. Read `hostedTourCoreUrl` in `grok-template/template.json`
before any start command. If that value is non-empty https and the operator
did not explicitly request a local demo, self-hosting, or an open-source local
deployment, the deployment is HOSTED. There is no discretion. A request to
clone the repository, read setup instructions, or follow GROK_BOOTSTRAP.md is
not a local-hosting request. Do not choose a local install because the
operator asked you to clone. The open-source runtime is only for an empty
`hostedTourCoreUrl`, or for that explicit local or self-host request.

## When to use

The operator says "Set up Tour Core", asks what's left to set up, asks you to
check the installation or whether Tour Core is running, or a Tour Core tool
stops answering.

## Required inputs and access

- Nothing from the operator to start. No attached files: the repository's
  `GROK_BOOTSTRAP.md` is the entry point and this skill is the detailed
  workflow.
- Your cloud computer, with a terminal and a browser.
- The Tour Core repository address, first found of: the canonical
  `repository.url` in `grok-template/template.json` (an installed template
  already knows it), the address in the operator's message, or
  `TOURCORE_REPO_URL` on your computer. If none is available, ask the operator
  for the public Tour Core repository link; that's the only thing you may ask
  before installing.
- If the address you were given and the canonical `repository.url` disagree,
  stop and ask the operator which to trust. `npm run bootstrap:grok` refuses
  to start an unexpected repository.

## How you talk

Say what's happening, in plain words. Say `operatorMessage` (in your own
words if you like) and nothing technical. Credentials are collected with a
secure secret input and filled into Tour Core's form, not in chat.

| Instead of | Say |
| --- | --- |
| "Your MCP server is https://.../mcp and exposes 42 tools." | "Tour Core is installed and running." |
| "The Cloudflare quick tunnel is connected." | "Tour Core has a secure public connection." |
| "Deploy Railway and set PORT." | "Tour Core is online." |
| "The OAuth MCP connector needs approval." | "I need your approval to connect to Tour Core." |
| "I'm creating a Grok Routine with an authenticated trigger." | "I'm setting up your tour updates." |
| "Everything runs in demo mode." | "Visitor texting is live. Door access is still in demo mode, so no physical locks will open." |

In normal conversation never mention addresses or links, `/mcp`,
`trycloudflare`, tool counts, connectors, OAuth, environment variables, ports,
package or command names, process ids, adapters or tunnels. `grokInstructions`
and anything under `technical` are for you only. Share technical details only
if the operator asks for them or you're troubleshooting with them.

The operator stays in this conversation except for a human-only authorization:
OAuth Allow, a provider login, or MFA. API keys, secrets, account ids, and
phone numbers are collected with Grok's secure secret input. You fill and
submit Tour Core's form. Do not tell them to open a setup page unless that
secure input could not be used.

## Sequence

Seven phases, always forward. Go back only when Tour Core's status changes
(for example its connection changed or Tour Core stopped). Never skip a phase.

### Phase 1: Bootstrap (you, alone)

If Tour Core's tools already answer, call `get_state` and go to
the phase it reports: don't reinstall a running Tour Core.

When the deployment is HOSTED, say:

> I'll connect you to Tour Core and only ask when I need an approval, sign-in or decision.

Connect to that service at `hostedTourCoreUrl`. You may clone the repository
to read instructions and skills. That clone is not a runtime. Do not run `npm run bootstrap:grok`. Never launch a Tour Core server here. Never start cloudflared. Do not create a Quick Tunnel. Do not connect MCP to a tunnel
address. Do not store operational records on your computer. Skip cloning a runtime, skip a local Node process, and skip any tunnel. Never tell the
operator that Tour Core only works while your computer is on. Do not say
Tour Core's Google app is not configured, and do not offer to keep records
on your computer. Google Drive, when recommended, is Grok's built-in
connector for portable backups (`backup_records`), not a second
Google approval. Then go to Phase 2.

Otherwise the operator explicitly chose local or self-hosting, or
`hostedTourCoreUrl` is empty. Say: "I'll handle the technical setup
and only ask when I need a login, approval or decision." On your cloud
computer:

1. Clone into `tour-core` unless that folder already exists (it holds the
   records). Load the other skills from its `.grok/skills/`.
2. Run `npm run bootstrap:grok` in that folder. Its output ends with the line
   to tell the operator and your own next step. It's safe to repeat; if Tour
   Core stops later, run it again.
3. If it reports a blocker you can fix on your computer (for example
   installing cloudflared), fix it and run it again. Otherwise tell the
   operator in one plain sentence what's blocking.

### Phase 2: Connect (the operator approves, once)

For a fresh install there's no existing Tour Core connection. Add Tour Core
yourself. On the hosted product, the operator approves in the browser Tour
Core opens:

> Tour Core is online. I need your approval to connect. Tour Core will show you a pairing code and a box for your invite code. Type the invite code you got, then click Allow.

On the open-source path, open the approval screen in your cloud browser:

> Tour Core is installed and running. I need your approval to connect to it.
> I've opened the approval screen. Check that the codes match and click Allow.

As soon as it's approved, without waiting to be asked:

> Connected. I'm checking the rest of the setup now.

and call `get_state`. An old Tour Core connection left over from
before is an exception: remove it and connect again the same way.

On the hosted service, when `get_state` says this number isn't set up yet,
ask its `say` question right away, with its `choices` as buttons (Tour Core
for self-guided tours of a rental unit, or Cleaner Core for a cleaner). If the operator already said they
want tours, skip the question. Call `choose_service` with their pick, then
call `get_state` again. If the new tools don't appear, ask the operator to
start a new chat.

### Phase 3: Infrastructure (follow Tour Core's order)

Call `get_state` and do exactly that step. Repeat after each
one. While `infrastructureReady` is false:

- follow the step Tour Core gives you, even if something else seems possible;
- don't offer other setup, alternatives or shortcuts;
- don't ask the operator what to do next or which order they prefer;
- don't start property setup.

By `performedBy`:

- **GROK**: do it yourself (the `tool`, or the `command` on your computer),
  then say briefly what happened ("Visitor texting is connected and working.").
- **OPERATOR_IN_SECURE_SETUP**: Prefer Grok's secure secret input. Say `operatorMessage`. For messaging credentials that sentence is "I'll ask for them securely; they won't be shown to me in chat." Collect only `credentialFields`. The values
  are not shown in chat and are not tool arguments. Call
  `get_state` for the secure setup step, fill the form, and submit it
  yourself. Do not show the link. Do not tell the operator to open a page.
  When it is saved, call `get_state` and continue. Do not ask
  what to do next. The same secure fill applies to a routine webhook address
  and key. Hand the browser to the operator only when secure fill isn't
  available; say that the normal secure collection could not be used.
- **OPERATOR**: say `operatorMessage` and wait (a login, MFA, provider terms,
  an approval).
- **OPERATOR_DECISION**: ask `operatorMessage` and wait for the answer.

Visitor texting is part of this phase: it's connected and tested before any
property. If the next step is choosing a provider, ask `operatorMessage` and
offer only the returned choices. Do not assume Sendblue. Do not give legal or
compliance advice beyond each choice's description. After they pick, call
`set_up_texting`, then follow the next step. If they switch back to a
provider that already has saved account details, follow that next step (usually
a connection test) and do not ask them to re-enter those credentials. If Photon
lists more than one line, ask which one and call `set_up_texting`. QA local texts
are on the QA connector, not this chat. Do not switch the
whole installation to local when another building is already published and
receiving real texts. Switching to `local` does not clear carrier secrets. Then Tour Core
recommends Google Drive, before the first property.
The access system ("Demo") needs nothing from the operator.

On the hosted product, Google Drive is a portable backup. The live records
stay with hosted Tour Core. There is no second Google approval. When the next
step is confirming the backup destination, say:

> Visitor texting is connected. Next I recommend Google Drive so I can keep portable backups and exports of your Tour Core records there.

If they say yes, use your built-in Google Drive connector. If it is already
connected, reuse it. Do not ask for a Google password, client id, client
secret, or API key. Create or find a private folder named Tour Core, with
Backups, Exports, and Properties inside. Do not make a public sharing link.
Then call `backup_records` (`provider` google_drive, `folderName`
Tour Core). Say:

> Google Drive is connected. I've prepared your Tour Core folder.

If they say no, call `backup_records` to decline. Say:

> Operational records stay with hosted Tour Core. Portable backups are off until you connect Google Drive.

Property setup continues. When records are already on this computer, or Google
Drive is still waiting for approval, the same decline says:

> Your records stay on this computer. Portable backups stay off until Google Drive is connected.

On the open-source path, when the next step is Google Drive's own approval, say:

> Visitor texting is working. Next I recommend connecting Google Drive so your property and tour records stay with you even if this Tour Core computer changes.

If they say yes:

1. If your built-in Google Drive connector is not connected, connect it the normal way and let them approve Google. Do not ask for a Google password, API key, or client secret.
2. Self-hosted Google Drive setup is on the ops connector, not this landlord chat. Say:

   > Google Drive is connected to me. For Tour Core to save its records there directly, whoever runs your Tour Core computer has to finish one more approval. Until then, your records stay on this computer.

3. Then call `get_state`. Records stay on this computer until that approval is done.
4. If Google Drive is not configured, say:

   > Google Drive isn't set up for Tour Core yet, so I'll keep your records on this computer for now.

   Do not ask them to create a Google Cloud project.

If they say no, keep records on this computer for the demo and say:

> Your records are stored with this demo installation and won't be portable if this Tour Core computer is replaced.

Questions like "Where are my Tour Core records?" are answered from `get_state`. Open or browse the folder with your Google Drive connector. Don't reconstruct bookings from the files when a Tour Core tool can answer.

### Phase 4: Property

When Tour Core reports the infrastructure ready (visitor texting connected and
tested), it offers the first property. Alerts are not part of this: they come
later and are never required. Close the technical part and say:

> Everything needed to start is connected and tested. Would you like to add
> your first property?

If yes, use the Setup Property skill (Map Route for routes), in plain words:
"What's the property address?" (then confirm the address as Tour Core saved
it), "What type of property is this?" (single-family home; multifamily —
duplex or small building they own; apartment or condo — one unit), then the
question Tour Core returns about the spaces people tour (unit number and
building-door control for an apartment or condo), each unit's bedrooms,
bathrooms, rent and availability, "Which door do visitors come in through?"
when they control a building entrance, "When can people tour?", "How
carefully do you want to verify visitors?", then Tour Core's optional question
about a visitor help number (they can skip it). Never show field names and never
invent a building name: the address is the property's name unless the
operator gives one. An apartment or condo is named as street plus unit.

Visitor texting was connected in Phase 3, so the new property uses it on its
own and the review reads "Visitor texting: Connected" (or "Visitor texting:
test mode" for local or test-mode texting) and "Door access: Demo".
Don't ask how to text people. From here on, don't talk about infrastructure
unless something breaks.

Once the property is saved (with its unit details), Tour Core offers tour
updates (recommended, not required). Ask only this, and do not ask a second
question:

> Want me to text you when someone books, starts, or finishes a tour, and ping you the moment something needs you?

- **Yes.** Call `save_settings` with the tour-update choice they asked for. Then:

  > I'm setting up your tour updates.

  Connect the updates yourself, in this order:

  1. Create the Tour Core Operator Updates routine yourself (authenticated
     webhook trigger; instructions in `grok-template/routines/operator-updates.md`).
  2. Call `get_state` and use the secure setup step it names for operator alerts.
  3. Ask for the routine address and key through secure secret input and fill
     Tour Core's form yourself. They stay out of chat and out of tool
     arguments. If secure fill isn't available and the values stay hidden
     behind copy buttons, copy them into the masked fields without reading
     them. If either value is shown on screen, hand the browser to the
     operator instead of moving it.
  4. Never put the address or key in chat, tool arguments, files or commands.

  Then call `get_state`: Tour Core has you send a test update
  and the routine posts "Tour updates are connected."
  If preferences are saved but the connection isn't finished, the next step is
  `CONNECT_OPERATOR_ALERTS`: pick up at step 2.
- **No.** Call `get_state` and continue. They
  can turn updates on any time later.

If `get_state` says a tour update didn't reach them, say "A tour update didn't reach you. Check your inbox for anything new. I'm sending a test so the next ones get through." and send the test that step names. Do not ask the first-time question, do not create a routine, and do not ask for a new address or key. That line waits until an open public-connection check or Grok connection is finished. A later ordinary delivery does not clear the miss. After that test gets through, the ready line is back. If the test does not get through and an alert address is already saved, say "Tour updates aren't reaching you. I'll send you a secure link to reconnect them. Nothing you type there shows in chat." The secure page overwrites the saved address and key with no history, so re-enter the existing routine's address and key there. Never create a new routine or use a new routine's address or key. When no address is saved, use the first-time setup above.

To see or change what they get later, use `get_state` and `save_settings`. Missed tours (no-shows) aren't detected yet;
don't promise them.

Never decide yourself whether a component is required: Tour Core marks each
one (`requirement`).

### Phase 5: Validate (automatic)

Tell the operator how visitors use it, then run the checks without asking
whether to skip them:

> Prospects can text your touring number to ask questions, choose a day and
> time, verify their details, and complete the self-guided tour in the same
> conversation. That one number covers every property. I'll run a readiness
> check and a practice tour before we turn it on.

Use Run Readiness Check, then Simulate Tour. If something fails, say what in
plain words and fix it with the operator.

### Phase 6: Publish (explicit yes)

> Everything passed. Would you like me to publish this property for demo?

Publish only after a clear yes, through the publish tool's own confirmation
question. Ask that question once. When the operator says yes, call the tool
with the code, wait for the result, then call `get_state`. Say
the property is published only when that status says so. Do not repeat the
pre-publish question, and do not say publishing still needs a yes, after the
tool has published it. A later call that finds it already published changes
nothing. If a tour update arrives while you are installing, ignore your
memory of the previous step and call `get_state` again.
Tour Core's status wins. If publishing is refused because visitor texting is
connected but the property isn't using it yet, fix it yourself (switch the
property to real texts, run the readiness check and practice tour again, then
ask the publish question again). Don't ask the operator how to text people.

### Phase 7: Operate

> Your property is published. Visitor texting is live. Door access is still in
> demo mode, so no physical locks will open. I'll keep you updated on your
> tours and let you know when something needs your attention.

Then follow `get_state`. When a property is already in
operation, that step is `ADD_ANOTHER_PROPERTY`: ask its question, and if they
want one more building call `save_property` with the address they
give (Setup Property skill). The building already published is not sent back
to draft. If they don't want another, stop.

On the hosted product, after the first publish, create a portable backup
(`backup_records`), save the file in Tour Core/Backups with the
Google Drive connector, confirm the file is there, then call
`backup_records` to confirm it was stored. Say:

> I've also saved a portable backup of this setup to your Google Drive.

A backup that fails does not unpublish the property or stop a tour. Later
backups use the Backup Tour Core skill. Do not say a backup is saved until
`backup_records` succeeds. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. `c = json.load(f)["contents"]` `hashlib.sha256(json.dumps(c, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")).hexdigest()`

Describe each part as it is (texting live, door access demo); never say
"everything runs in demo mode". From here, when the Tour Core Operator Updates
routine wakes you, call `get_inbox` with its `eventId` and post the
`summary` (Work Exception covers issues). Each item that had an alert includes its eventId. When the visitor has no name, the summary starts Visitor at {number}, {place}:.
A named visitor stays their first name. The ping stays ids only. Work exceptions when the operator
asks.

## Reset a hosted demo

Only when the deployment is HOSTED and the operator asks to reset Tour Core
for a fresh demo or a fresh onboarding test. Call `reset_hosted_demo` with
no confirmation code. Read Tour Core's warning to the operator, including
what will be erased and what will be kept. If they clearly say yes, call
`reset_hosted_demo` again with that `confirmationCode` and nothing else.

When it succeeds, say:

> Tour Core has been reset. This connection is no longer authorized, which is expected. You can delete this Bot and start the fresh onboarding test.

Do not reconnect this Bot. The next test uses a new Bot and the normal hosted
bootstrap. Do not delete `/data`, run `rm`, edit files, delete the Railway
service, delete Google Drive files, or reset a provider account yourself.
There is no separate owner-reset step after this.

## Validate

- After every step, check Tour Core's status and report the result as-is.
  Never say something is connected or working unless Tour Core says READY.
- If a test fails, say so plainly and follow Tour Core's next step. Don't
  improvise workarounds.
- On the hosted product, if the ops connector (or `/healthz`) shows
  `persistentVolume` false, say Tour Core's health line as it is.
  Whoever set up your Tour Core hosting needs to attach permanent storage. Until then, hold off on updating Tour Core.
  Never set, recommend, or ask
  anyone to set `TOURCORE_ALLOW_EPHEMERAL_STORAGE` on a live service. Do not
  mention that variable, or any other environment variable, to the operator.
  Say:

  > Tour Core is running, but your records aren't saved anywhere permanent yet, so the next update could erase them.

## Return

One or two plain sentences about where things stand and the next thing
happening, for example "Visitor texting is connected and working. Everything
needed to run Tour Core is connected and tested. Would you like to add your
first property?"

## Requires approval

Approving the connection to Tour Core (the operator clicks Allow), supplying
credentials through Grok's secure secret input (or taking over the form only
when that input isn't available), choosing or declining tour updates
(the operator's choice), and publishing (explicit yes).

## Stop when

- The next step offers another property and the operator doesn't want one,
  or the operator has what they asked for. Don't stop at the first publish
  before that offer.
- A person has to act (approval, login, MFA, or provider terms): say what to
  do and wait. A setup form is only for the operator when secure input could
  not be used.
- A provider account is blocked or refuses the details: say so plainly.
- The hosted service can't be reached: say what's blocking in one sentence, without asking the operator to create a hosting account.
- Your cloud computer can't run the open-source path: say what's blocking in one sentence.
- A tool refuses or reports an error its next step doesn't resolve.
- The operator declines a required step.

## Never

- Ask for, accept, repeat or store passwords, API keys, secrets, tokens or
  webhook addresses in chat. If the operator pastes one anyway, don't repeat
  it; tell them to rotate it and supply the new value through secure secret input.
- Put credentials in commands, files or tool arguments.
- Ask the operator to run commands, create a hosting account, or choose the setup order.
- On the hosted product, clone Tour Core as the runtime, start a local service, start a quick tunnel, or say it only works while your computer is on.
- Reset a hosted demo by deleting files, the data volume, the Railway service, Google Drive files, or provider resources. Use `reset_hosted_demo` only.
- Offer property setup before Tour Core does, or skip the readiness check or
  practice tour.
- Claim setup is zero-click. Some steps always need the operator.
- Set or recommend `TOURCORE_ALLOW_EPHEMERAL_STORAGE` on a live hosted
  service. That switch is only for disposable demos. The fix is attaching a
  volume.
