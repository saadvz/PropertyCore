# Manual test: Tour Core Bot in a real Grok Bot (P0 operator demo)

This is the manual real end-to-end regression script. **B** is the main run:
a fresh Grok-managed install, from one prompt to a published property with
tour updates, where the operator never touches their own terminal. **C** is
the visitor test on that published property, **D** the negative checks, and
**A** turns tour updates on for an install that already exists. The original
connection and operator-demo tests follow.

Record pass/fail, a screenshot and who acted (Grok or the operator) for each
row.

## A. Existing install: turn on tour updates

Needs: Grok connected to your current Tour Core (the connection tests below
pass), a published property, and a real phone that's a verified Sendblue
contact. Instructions for the routine Grok creates:
[`grok-template/routines/operator-updates.md`](../grok-template/routines/operator-updates.md).

| # | Do | Expect |
| --- | --- | --- |
| A1 | Update Tour Core (restart `npm run setup` or `npm run service:restart`). Ask Grok *"Check my Tour Core installation."* | Grok calls `get_state` and answers with a checklist: runtime, secure connection, Grok connection, visitor texting, tour records stored with this installation, access system Demo, "Tour updates aren't turned on yet" (or "Tour updates are off" if you declined before) |
| A2 | *"Turn on tour updates."* | Grok asks only "Want me to text you when someone books, starts, or finishes a tour, and ping you the moment something needs you?" Say yes: Grok calls `save_settings`, says "I'm setting up your tour updates.", creates the **Tour Core Operator Updates** routine itself, and asks for the webhook address and key with a secure secret input. Grok does not ask a second question about defaults |
| A3 | Submit that secure input | The values do not appear in chat. Grok submits them, and the routine posts "Tour updates are connected. I'll let you know about your tours here." Opening the setup page is only the fallback when that input cannot be used |
| A4 | Open the same setup link from another device, or `https://<tunnel>/install` | Not found |
| A5 | Ask Grok *"Test tour updates."* | The routine posts again; Grok never shows the address or key. Search the chat: neither value appears |
| A6 | *"What updates am I getting?"*, then *"Only tell me about problems."* | Grok reads `get_state` (bookings, tour starts, completions and anything that needs attention), then saves `problems-only` with `save_settings`. A new booking from the phone produces no update; an unknown question still does |

## B. Fresh Grok Bot, one prompt, no attachments

This is the development / open-source bootstrap, and only when the operator
explicitly asks to run Tour Core locally or to self-host, or when the cloned
`grok-template/template.json` has an empty `hostedTourCoreUrl`. If that field
is a non-empty https address, the prompt below selects the hosted service:
do not run `npm run bootstrap:grok`, do not start cloudflared, and follow
section H instead of the local rows. Start with a **completely
fresh** Grok Bot and a fresh Sendblue test setup. Do **not** attach
`bot-profile.md`, any `SKILL.md`, `template.json` or the `grok-template`
folder. The operator must not open a terminal on their own computer at any
point. Record where a person had to act.

Send only this (with the real repository address):

> Set up Tour Core, my AI landlord, using the open-source repository at
> https://github.com/&lt;owner&gt;/&lt;repo&gt;.
>
> Use your cloud computer to clone the repository only so you can read its
> setup instructions and skills. If the repository specifies an official hosted
> Tour Core service, use that service rather than starting Tour Core locally.
> Read and follow the repository's GROK_BOOTSTRAP.md instructions as the
> authoritative installation guide.
>
> Do as much of the setup yourself as possible. Never ask me to paste secrets
> into chat. Collect credentials with your secure secret input and submit
> them yourself. I leave the conversation only to approve a connection, sign
> in, or pass MFA. After Tour Core is running, use its installation-status
> tools to determine what remains, test every component, then offer to
> configure my first property.
>
> Start now.

| # | Do | Expect |
| --- | --- | --- |
| B1 | Send the prompt above, nothing else | No files attached; Grok asks for nothing before starting |
| B2 | Watch Grok's cloud computer (**step 1: bootstrap Tour Core**) | Grok clones the repository on **its own** cloud computer, reads `GROK_BOOTSTRAP.md`, loads `.grok/skills/install-tour-core/SKILL.md` (and the other skills from `.grok/skills/`), and runs `npm run bootstrap:grok` |
| B2a | (Once `repository.url` is set) Repeat with a different repository address in the prompt | Grok stops and asks which repository to trust; `npm run bootstrap:grok` refuses to start ("Not starting an unexpected repository") |
| B3 | Read Grok's first message | Approximately: "I'll handle the technical setup and only ask when I need a login, approval or decision." Grok installs Tour Core without narrating the technical steps |
| B4 | Wait | "Tour Core is installed and running. I need your approval to connect to it. I've opened the approval screen. Check that the codes match and click Allow." The approval screen is in Grok's cloud browser |
| B5 | Take over the browser, check the codes match, click **Allow** | Without being asked: "Connected. I'm checking the rest of the setup now." Grok calls `get_state` |
| B6 | Wait (**step 2: choose visitor texting**) | "How would you like prospects to text Tour Core?" with Sendblue, Twilio, and Photon. Grok does **not** say texting runs through Sendblue, and does **not** ask you to open a setup page |
| B6a | Say *"Sendblue"* (this script continues on Sendblue so the later phone steps have a number) | "Sendblue needs your API key, API secret, and messaging number. I'll ask for them securely; they won't be shown to me in chat." A secure input appears. Grok does **not** offer property setup, ask what to do next, or ask for the key in chat |
| B7 | Submit the secure input. Do not open a browser to type the key, secret, or number | Grok fills and submits the form, tests texting, then: "Visitor texting is connected and working. Everything needed to start is connected and tested. Would you like to add your first property?" |
| B7a | Right after texting is connected | Grok does **not** mention tour updates, and never calls them required |
| B8 | Say yes (**step 3: create property**). Grok asks "What's the property address?"; answer *"144 Hillside Ave, Teaneck NJ"* | Grok calls `save_property` with the address only. It asks "What ZIP code should I use?" and does not invent one |
| B8a | Answer *"07666"* | Grok reads back 144 Hillside Ave / Teaneck, NJ 07666 and waits for yes before property type |
| B9 | **Step 4: confirm canonical address** | After yes, Grok saves the confirmation and the guessed time zone, and asks if the time zone is right |
| B10 | **Step 5: property type** | "What type of property is this?" with single-family home; multifamily (duplex / small building you own); apartment or condo (one unit). No whole-building apartment option. Answer *"Multifamily"*: Grok saves it (`save_property`) and asks "Which units can people tour?" (A single-family answer would get "Should I call it "Main Home"...?" instead, never a made-up unit number. An apartment or condo answer asks "What's the unit number?", then "Do you control the building entrance, or only the unit door?") |
| B11 | **Step 6: units and unit profiles.** Answer *"1A, 1B, 2A and 2B."*, then in one go: *"1A and 1B are 2 bed 1 bath for $2,200. 2A is 3 bed 2 bath for $2,800 and 2B is 2 bed 2 bath for $2,500."* | Grok reads back one line per unit (e.g. "Unit 1A — 2 bed · 1 bath · $2,200/month · availability not given yet") and asks only "When are these units available?". Answer *"1A and 1B now, 2A October 15, 2B not sure yet"*, and when optional details are offered: *"All units have in-unit laundry."* Grok asks "Does that look right?" before doors; nothing was invented, and "not sure yet" shows as not listed |
| B12 | **Step 7: map routes.** *"Visitors come in the main entrance. No inside doors."* | `save_doors_and_routes` Main Entrance; Grok shows "Main Entrance → Unit 1A Door" (etc.) and asks "Is that right?" before saving each route |
| B13 | **Step 8: tour hours.** *"Every day, 9 to 6."* | Grok reads back the days and hours with the defaults (45-minute tours, a new tour every hour, 10 minutes early) |
| B14 | **Step 9: verification.** *"Basic form."* | Saved as the basic identity form. The other choice is no form, which asks "Without a form, anyone who texts can book a tour and get in without telling you who they are. Want to go ahead with no form?" and saves only after yes |
| B15 | **Step 10: texting is automatic.** Watch the next message | Grok does **not** ask "How do you want to text people?" or where to keep records. The review lists: 144 Hillside Ave, Teaneck NJ / Multifamily (duplex / small building you own) / each unit with its details line and route / "Tours: ..." / "Verification: ..." / "Visitor texting: Connected" / "Door access: Demo", then "Does that look right?" |
| B16 | Say yes (**step 11: offer tour updates**) | Grok asks only "Want me to text you when someone books, starts, or finishes a tour, and ping you the moment something needs you?" Say *"Sure"*. Grok does not ask a second question. Grok calls `save_settings` (recommended) and says "I'm setting up your tour updates." (Saying no instead skips updates and moves on) |
| B16a | Watch Grok's cloud computer | Grok creates the **Tour Core Operator Updates** routine itself (authenticated webhook trigger) and asks for the webhook address and key with a secure secret input |
| B16b | Handoff | Submit that secure input. The values do not appear in chat, tool arguments, files, or commands. If secure input cannot be used and both values stay hidden behind copy buttons, Grok may paste them into the masked fields without reading them. If a value is shown on screen, Grok hands you the browser |
| B16c | After saving | The routine posts "Tour updates are connected. I'll let you know about your tours here." |
| B17 | Wait (**step 12: readiness**) | "Prospects can text your touring number to ask questions, choose a day and time, verify their details, and complete the self-guided tour in the same conversation. I'll run a readiness check and a practice tour before we turn it on." Grok runs the readiness check without asking whether to skip it |
| B18 | Wait (**step 13: practice tour**) | Practice tour passes with its proof points; no text reaches your phone, and no tour update is posted for it |
| B19 | **Step 14: publish.** Grok: "Everything passed. Would you like me to publish 144 Hillside Ave for demo?" Say *"not yet"*, then *"yes"* | "not yet": still Draft. "yes": Grok publishes once, waits for the result, then says "Your property is published. Visitor texting is live. Door access is still in demo mode, so no physical locks will open. I'll keep you updated on your tours and let you know when something needs your attention." It does not ask for another yes, and it does not say publishing still needs a yes. Never "everything runs in demo mode" |
| B19a | Throughout B3–B19 | None of these appear in the chat: a `trycloudflare.com` address, `/mcp`, a tool count, "connector", "OAuth", "tunnel", "webhook", "routine", ports, commands, environment variables or process ids. Grok never asks which setup step to do next |
| B20 | On the cloud computer, stop Tour Core (Grok runs `npm run service:stop`), then ask Grok anything | Grok notices Tour Core isn't answering, runs `npm run bootstrap:grok`, and Tour Core is back with the same installation (same records) |
| B21 | Stop the tunnel too (`npm run service:stop -- --tunnel`) and bootstrap again | New `trycloudflare.com` address. Status shows the Grok connection and visitor texting need action. Grok reconnects (you approve again) and runs `set_up_texting`, which moves Sendblue's webhook to the new address |

Pass = no attached files, no terminal on the operator's computer, no
credential in chat, no infrastructure jargon in the happy path, the operator
only approved, signed in, submitted credentials through Grok's secure input,
answered property questions and made decisions, and the order was exactly:
texting → property (address, type, units with details, routes, hours,
verification; texting automatic) → offer tour updates → readiness → practice
tour → publish.

## C. Visitor test on the published property

Continue from B with the property published and tour updates on. Use the real
phone. "Testy" below is whatever first name you give on the identity form.

| # | Do | Expect |
| --- | --- | --- |
| C1 | Text the touring number *"Hi"* | One message: "Hi! Welcome to the self-guided tours at 144 Hillside Ave. I can answer questions about the property and help you book a tour." plus the unit menu. Not a second introduction |
| C2 | Before choosing, text *"How much is 1A?"* | The answer from Unit 1A's details ($2,200/month), then the same unit menu again. No booking was needed to ask |
| C3 | Choose Unit 1A | Offered times, e.g. "I have 2:00 PM and 3:30 PM available on ... Which works for you?" |
| C4 | While choosing a time, text *"Does it have laundry?"* | The laundry answer from the unit details, then the **same** times re-presented |
| C5 | Pick a time, agree to texts, fill the identity form | Booking confirmed on the phone. Without anyone asking, Grok posts "New tour booked: Testy is scheduled to tour Unit 1A today at ..." |
| C6 | Arrive (developer mode "Move tour to now" if needed) and start the tour | Grok posts "Testy's Unit 1A tour has started." |
| C7 | Inside, text *"Is there a pool?"* | Immediately: "I'll pass your question to the {team}, and they'll reply here as soon as they can." Grok, unprompted, tells you Testy asked about a pool and asks what to tell them (not a yes/no) |
| C8 | Reply *"No pool, but there's a gym on the roof."*, then *"yes"* to Grok's one confirmation | The phone gets exactly that answer, then the tour step it was on. The property stays **Published for demo**; no readiness check or practice tour is asked for |
| C9 | *"What needs attention?"* | Nothing: the question is resolved |
| C10 | Finish the tour from the phone ("I'm done", "yes") | Recap and follow-up on the phone. Grok posts "Testy's Unit 1A tour is complete." |
| C11 | Ask Grok to change the tour hours | Grok says this is a structural change; afterwards the property is back to draft and needs readiness, a practice tour and your yes to republish |

## D. Negative checks

| # | Do | Expect |
| --- | --- | --- |
| D1 | Look at a delivered update's payload (the routine's run history in Grok, or Tour Core's outbox on the cloud computer) | Only `schemaVersion`, `eventId`, `eventType`, `propertyId`, `tourId` or `exceptionId`, `occurredAt`. No visitor names, phone numbers or message text |
| D2 | From a new phone thread, before choosing a unit, text *"How much is it?"* | "Which unit do you mean: 1A, 1B, 2A or 2B?" Answer *"2A"*: the rent, then the unit menu again |
| D3 | In the browser app, switch the property to practice texts, then ask Grok to publish | Publishing is refused: "Visitor texting is connected, but this property isn't using it yet. I'll connect the property to your touring number before publishing." Grok switches it back itself, reruns the readiness check and practice tour, and asks the publish question again. It never asks how to text people |
| D4 | Run a practice tour, and a tour in the browser demo | No tour updates are posted for either |
| D5 | Turn on cancellations (*"Also tell me about cancellations."*) after a tour was already cancelled | Only cancellations from now on are posted; the earlier one is never sent late |
| D6 | Break updates on purpose: on the secure setup page enter a wrong key; text a new unknown question | The visitor still gets the fallback at once. `get_state` shows tour updates as an error. Enter the right key again: the pending update is delivered once, with no duplicate |
| D7 | Search the whole chat | Never "everything runs in demo mode", never the routine's address or key, never ids or codes |

The final template experience is simpler still: install the Tour Core Bot
template and say *"Set up Tour Core."* The template already knows the
canonical repository and the bootstrap behavior, so rows B2 onward apply
unchanged.

---

## Connection and operator demo

Not part of `npm test`. Needs a Grok Bot account, the Tour Core computer with
Sendblue and a tunnel ([Tour Core guide](tour-core/README.md)), and one real phone that's a verified Sendblue
contact. Use a fresh `TOURCORE_HOME` so earlier properties don't interfere:

```powershell
$env:TOURCORE_HOME = "$PWD\tourcore-grok-test"; npm run setup
```

`.env` must not set `TOURCORE_MCP_AUTH_MODE` (OAuth is the default). If an
earlier static setup left a Tour Core connector with a `Bearer` header in
Grok, remove it first.

Record pass/fail and a screenshot for each step.

### P0 only: Grok legacy OAuth compatibility

Grok Bot currently connects through Cursor's MCP client. When it registers
with Tour Core (Dynamic Client Registration), it sends this callback set:

```
cursor://anysphere.cursor-mcp/oauth/callback
https://www.cursor.com/agents/mcp/oauth/callback
http://localhost:8787/callback
```

Normal Tour Core OAuth stays strict. It allows https on Grok's hosts, or a
loopback address. So it refuses the whole registration because of the first
two, and Grok never reaches the approval page. The Tour Core window shows
`Refused an MCP client registration from "Cursor" ...` with one
`refused redirect: scheme=... host=... path=... reason: ...` line per URI.

This flag exists only because of that currently observed Grok Bot/Cursor
behavior. `HOSTED_RAILWAY_P0` turns the narrow list on by default, so a
Railway deploy does not need `TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true`.
Set it to `false` only to turn that default off. `true` still forces it on
in any mode. `LOCAL_DEVELOPER` and `SELF_HOSTED` stay strict until the
variable is exactly `true`. `GROK_MANAGED_P0` still enables it at bootstrap
unless `--strict-oauth` was used.

To enable it for local or self-hosted P0 Grok testing:

1. Add to `.env`: `TOURCORE_GROK_LEGACY_OAUTH_COMPAT=true`
2. Restart Tour Core (`Ctrl+C`, `npm run setup`). The startup lines now include
   the warning *"Grok legacy OAuth compatibility is enabled for this P0 demo..."*,
   and so does the Connect Grok page. `npm run grok:status` shows
   `Grok legacy .... ON`.
3. In Grok, remove the Tour Core connector if it's half-added, then add it again
   and go through C3–C7 below.

What it changes: registration also accepts exactly
`cursor://anysphere.cursor-mcp/oauth/callback` and
`https://www.cursor.com/agents/mcp/oauth/callback`. They must match as exact
strings. Nothing else is accepted: no other `cursor://` address, no other
custom scheme, no other `cursor.com` or `cursor.sh` host or path, and no
wildcards. Everything else is unchanged:

- owner approval on this computer with the matching code
- PKCE S256, `state`, exact redirect match and single-use codes
- token lifetime, scope and revocation
- Tour Core's confirmation codes, policy and door access

`api2.cursor.sh` is **not** allowed. If a refusal line names it, copy that
whole `refused redirect: ...` line into the test notes. Only if the real flow
proves that exact URI is Grok's callback should it be considered.

**Turn it off** once Grok no longer registers the legacy callback. You'll know
because a registration with the flag off stops producing `scheme=cursor` or
`host=www.cursor.com` refusals. To turn it off, delete the line from `.env` and
restart Tour Core. Grok connections that used a legacy callback then need
reconnecting. Tour Core refuses those callbacks immediately once the flag is off.

### Connect with OAuth

| # | Do | Expect |
| --- | --- | --- |
| C1 | Tour Core and the tunnel running. On any computer: `curl -i -X POST https://<tunnel>/mcp` | `401`; `WWW-Authenticate: Bearer resource_metadata="https://<tunnel>/.well-known/oauth-protected-resource/mcp", scope="tourcore.operator"` |
| C2 | `curl https://<tunnel>/.well-known/oauth-protected-resource/mcp` and `curl https://<tunnel>/.well-known/oauth-authorization-server` | JSON; `authorization_servers` is `["https://<tunnel>"]`; the second lists `/authorize`, `/token`, `/register`, `/revoke`, `S256` |
| C3 | In Grok: New Connector → Custom → `https://<tunnel>/mcp`, no token or header | Grok opens a **Tour Core** page: "Grok is requesting permission to manage this Tour Core installation", can/can't lists, a six-digit code. Tour Core's window logs "An MCP client registered... (redirects: ...)" and "Authorization request from ...: will return to ..." (no 404, no refusal). Record both lines |
| C4 | On the Tour Core computer | A **Connect Grok** window opened by itself (else open `http://localhost:4321/grok`); same code as the Grok page |
| C5 | On the Grok-opened page, try to approve: there's no Allow there. From another device, open `https://<tunnel>/grok` | Only Deny on the public page; `/grok` through the tunnel is "Not found" |
| C6 | Click **Allow** on the Connect Grok window | Grok's page returns to Grok; Grok shows Tour Core connected; Connect Grok lists "Grok since ..." |
| C7 | Ask Grok *"List the Tour Core tools you can use."* then *"What's set up?"* | 22 landlord tools (the hosted owner also sees `reset_hosted_demo`). Ops and QA connectors are separate. Nothing unlocks a door or sets a credential. `get_state` runs and returns this Tour Core's properties |
| C8 | Search the Grok chat for any Tour Core token | None: no credential was ever typed or shown |
| C9 | (Later) Click **Disconnect Grok** (or `npm run grok:disconnect`), then ask Grok to list properties | Grok gets an authorization error and asks to reconnect; properties, tours and Sendblue unchanged. Reconnect (C3–C6) before continuing |
| C10 | Connect again, but click **Deny** | Grok reports the connection was refused; nothing connected |

If C3 fails with a registration error, the Tour Core window names the refused
redirect host. See "If Grok says the connection failed during registration" in
the [setup guide](grok-template-setup.md).

### Operator demo

| # | Do | Expect |
| --- | --- | --- |
| 1 | Add/install the Tour Core Bot ([setup guide](grok-template-setup.md) steps 3–5, or install from the team template and reconnect with OAuth as above). Ask *"List the Tour Core tools you can use."* | 54 Tour Core tools; nothing that unlocks or opens a door, and nothing that takes a credential |
| 2 | *"Set up a property"* | Bot asks "What's the property address?"; one question at a time; no field names or codes |
| 3 | Answer: 100 Alfred Way, Brooklyn NY; multifamily (small building you own); two units (101, 102); one entrance ("Lobby Entrance"); no hallway doors. Confirm routes when shown | Bot confirms the address, asks "What type of property is this?" with single-family / multifamily / apartment or condo (one unit); never invents a building name; shows "Lobby Entrance → Unit 101 Door" and asks "Is that right?" before saving; in the browser app the same property shows both routes |
| 3a | Say *"Unit 102 goes through the side gate"* | Bot says it doesn't have a side gate on file and lists the doors; nothing saved |
| 4 | Tour hours: *"Weekdays, 9 to 5"* | Bot reads back weekdays 9 AM–5 PM with the defaults |
| 5 | Verification: basic form | Bot doesn't ask how to text people (the property already uses the installed texting); `get_state` shows messaging connected |
| 6 | Confirm the read-back. Bot runs readiness | Checklist matches the browser app's readiness screen for the property, including "Visitor messaging connected" |
| 7 | Bot runs the practice tour | Proof points including early arrival denied and Unit 102 Door turned away before any door was unlocked; no text reaches your phone |
| 8 | Bot asks to publish. First say *"not yet"*, then *"yes"* | "not yet": still Draft in the browser app. "yes": Published for demo; Bot says visitor texting is live and door access is still in demo mode |
| 9 | From the real phone, text the Sendblue number "Hi" and book Unit 101 at the next time; consent; fill the identity form | Normal visitor flow (unchanged) |
| 10 | *"Show active tours"* | Your name, Unit 101, tour time, status; no ids |
| 11 | Arrive and enter Unit 101 (developer mode "Move tour to now" if needed). Text *"is parking included?"* | "I'll pass your question to the {team}, and they'll reply here as soon as they can." on the phone |
| 12 | *"What needs attention?"* | "They asked: "is parking included?" There's no approved answer yet. Tour still active." |
| 13 | *"Open that issue. Yes, parking is included."* Then *"yes"* | Bot asks once before adding the fact; after yes the phone gets the exact fact and the tour step it was on; issue shows handled; the property stays published |
| 13a | *"Pause the tour"*, *"yes"*; text "I'm at unit 101"; then *"resume it"*, *"yes"* | While paused the phone gets "Your tour is paused..." and no door opens; after resume doors work again in the window |
| 13b | *"Just unlock 102 for me"* | Bot refuses: it can't open doors |
| 14 | Finish the tour from the phone ("I'm done", "yes") | Recap and follow-up; *"Show active tours"* is empty |
| 15 | *"Export today's audit"* | Summary: 1 visitor tour completed, access denials, 1 question needing attention, plus practice tours; file listed; `http://localhost:<port>/api/properties/<id>/audit-exports/<export>/audit-export.json` opens on the Tour Core computer |
| 16 | Start a **new** Grok conversation and ask *"What's the status of 100 Alfred Way?"* | Same state as before (from Tour Core, not memory) |
| 17 | Restart Tour Core (Ctrl+C, `npm run setup`), then ask *"Show exceptions"* | Still answers without reconnecting (approvals survive a restart); a confirmation code from before the restart is refused if reused |
| 17a | Wait over an hour (or leave Grok idle), then ask anything | Still answers: Grok renewed its token. If Grok didn't register for refresh tokens it asks to reconnect instead; note which |
| 18 | Stop the tunnel and ask anything | Bot says the Tour Core connector is unreachable and stops; nothing is invented |

Also note what Grok actually did during C3 (from the Tour Core window): the
client name it registered, the redirect host, and whether it asked for
refresh tokens. Those facts aren't in xAI's public docs.

Pass = every row matches. The browser app stays usable throughout and shows
the same property, tours and history.

## E. Custom tour times

Property regular starts stay hourly (or whatever spacing was saved). A visitor
can ask for another minute, and the landlord can approve it once, without
changing that schedule.

| # | Do | Expect |
| --- | --- | --- |
| E1 | Visitor books 4:00 PM, then texts "Can I move it to 3:15?" | The visitor is told I've asked the {team}, and their 4:00 PM tour stays booked. No second booking |
| E2 | Watch Grok | Grok says, unprompted, that the visitor wants to move today's tour to 3:15 PM, and that 3:15 isn't a regular start. The webhook itself has no name or phone number |
| E3 | "Approve 3:15." | Grok asks once to confirm |
| E4 | "Yes." | The tour moves to 3:15 PM. The visitor is told. The property stays published. A new visitor is still offered the regular hourly times, not 3:15 |
| E5 | "Move them to 3:30." | Same one confirmation, then the tour moves to 3:30 PM and the visitor is told. Regular hours are unchanged |

## F. Date-first booking and property identity

Fresh Grok install. Property address given as "144 Hillside Ave, Teaneck, NJ"
with no ZIP. Single-family internal space: Main Home. No public property name.

| # | Do | Expect |
| --- | --- | --- |
| F1 | Give the address without a ZIP | Grok asks "What ZIP code should I use?" and does not save a made-up ZIP |
| F2 | Say the ZIP, then yes to the read-back | The address shown back is one line, "Did I get that right: 144 Hillside Avenue, Teaneck, NJ 07666?", before property type. A condo address with a unit includes it: "Did I get that right: 300 Main Street, Unit 4B, Hackensack, NJ 07601?". A missing street is "What's the street address?". A missing state is "What state is it in?" before any city question. A city given while the state is still missing is kept: "Got it. What state is that in?". "What city should I use?" comes only after the street and state are saved, and the address is not read back until street, city, state, and ZIP are saved. A street on its own keeps its suffix, so "144 Hillside Avenue" is read back with Avenue. A guessed time zone updates only before the address is confirmed, and never on a property that was published or already had a confirmed address or an operator-set zone |
| F3 | A visitor texts "Hi" | One opening message naming 144 Hillside Ave, not "Main Home". Then several upcoming tour days, not every time for one day |
| F4 | "What availability do you have?" | The same kind of short date list |
| F5 | "What about Thursday?" | Thursday's times. No exception for the property team |
| F6 | "How much is rent?" | The answer uses the address (or "this home"), then Thursday's times again. Not "Main Home" |
| F7 | Readiness, practice tour, then "Yes, publish it." | One publish. Grok says it is published only after the tool result and a fresh status read. No second publish question and no "still needs a yes" |

## F-condo. Apartment or condo (one unit)

Fresh Grok install. Address *"145 Main St, Hoboken, NJ 07030"*. No public name.

| # | Do | Expect |
| --- | --- | --- |
| C1 | After address confirm, choose **Apartment or condo (one unit)** | Grok asks "What's the unit number?" Never offers a whole-building apartment |
| C2 | *"4B"* | Saved as Unit 4B. Next: "Do you control the building entrance, or only the unit door?" |
| C3 | *"I control the building entrance."* Then *"Lobby Entrance"* | Route is Lobby Entrance → Unit 4B Door. Optional: "How should visitors get in and find your unit?" |
| C4 | Give instructions, or skip | Skip stores nothing. Review names it "Apartment or condo (one unit)" and does not say Main Home. Visitors and alerts say "145 Main St, Unit 4B" |
| C5 | Repeat C1–C2, then *"I only control the unit door."* Skip instructions | Route is Unit 4B Door only. No building door. Arrival text opens the unit door, not the entrance |
| C6 | Book, verify, read the you're-all-set text | Entry instructions appear here, only after verify, as `Here's how to get in: …`. Not in the welcome. Skip means that fragment is absent |

## G. Hosted portable backup

Needs a hosted Tour Core (`HOSTED_RAILWAY_P0`) and a Google account that can
approve Grok's Drive connector. Tour Core does not ask for its own Google
approval. Automated tests do not call Google.

| # | Do | Expect |
| --- | --- | --- |
| G1 | Fresh Grok bot. Connect hosted Tour Core. Allow. Choose a messaging provider and submit its credentials in the secure input | Grok recommends Google Drive for portable backups and exports. It does not ask for a Google password, client id, client secret, or a second approval |
| G2 | Approve Grok's Google Drive connector | Grok creates or finds a private Tour Core folder (Backups, Exports, Properties) and tells Tour Core the backup destination is configured |
| G3 | Continue | "Google Drive is connected. I've prepared your Tour Core folder." Then the first property. Status does not say "Google Drive canonical" or that a Tour Core Google client is missing |
| G4 | Create the property, updates, readiness, practice, publish | Grok saves a portable backup into Tour Core/Backups and says it is saved only after the file is there |
| G5 | "Open my Tour Core backup." | Grok opens that file with the Drive connector. The operational answer still comes from Tour Core |

### Portability

| # | Do | Expect |
| --- | --- | --- |
| G6 | Download the latest backup from Drive. Simulate a clean Tour Core with an empty volume | Grok uploads the backup through Tour Core's restore handoff. Tour Core shows a preview and waits |
| G7 | Approve the restore | Property, tour history, and facts are back. Visitor texting and operator updates say reconnect is required. No Sendblue or Google secret came from the file |

## H. Hosted Railway demo

`HOSTED_RAILWAY_P0` is one demo installation. A landlord does not create a
Railway account. Automated tests do not call Railway. This section is the
real deploy.

### Admin setup, once

| # | Do | Expect |
| --- | --- | --- |
| H1 | Push `saadvz/TourCore` and create one Railway service from that repo (`master`) | Railpack runs `npm run build` and `npm start`. No Docker |
| H2 | Generate a public domain. Mount a volume at `/data`. Set `TOURCORE_DEPLOYMENT_MODE=HOSTED_RAILWAY_P0` and `TOURCORE_HOME=/data`. Do not set a Tour Core Google OAuth client. Healthcheck path `/healthz`. Do not set `TOURCORE_GROK_LEGACY_OAUTH_COMPAT` | Deploy logs show the version, `HOSTED_RAILWAY_P0`, the port, the public host, `Railway volume (live operational store)`, and `Grok legacy OAuth compatibility active for HOSTED_RAILWAY_P0.` No credentials |
| H3 | Open `https://<domain>/healthz` | `200` and `"service":"tour-core"`. The URL does not contain `trycloudflare` |
| H4 | Set `hostedTourCoreUrl` in the bot template to `https://<domain>`. Do not register a Tour Core Google callback | Skills still say `hostedTourCoreUrl`, not a Railway hostname |
| H4b | Do not run an owner-claim step | There is no `/claim` page and no bootstrap secret in this flow |

### Fresh user

| # | Do | Expect |
| --- | --- | --- |
| H5 | Fresh Grok bot whose template has `hostedTourCoreUrl`. Say "Set up Tour Core." | Grok connects to the hosted service. It does not clone a runtime, start a tunnel, or say Tour Core only works while its computer is on. It does not mention Railway |
| H6 | Click Authorize. Tour Core shows a pairing code and says approving this first connection makes this Grok connection the owner of the demo. Click Allow | The browser returns to Grok. Grok says it is connected. Registering or calling tools did not claim the demo by itself. A second unrelated account is refused |
| H7 | Choose a messaging provider and submit its credentials in the secure input, then Grok's Google Drive connector, then the property, updates, readiness, practice, and publish | Webhook and verification links use the Railway host. There is no second Google approval. Records stay on the volume. A portable backup is saved under Tour Core/Backups |
| H8 | A real visitor texts the property | The tour proceeds. Operator updates come from the hosted service |

### Restart

| # | Do | Expect |
| --- | --- | --- |
| H9 | Redeploy or restart the Railway service | The public domain stays the same. `/healthz` returns 200 after startup. Logs do not show a quick-tunnel address. Startup does not wait on Google Drive |
| H10 | Ask Grok about the property. Send another text | The property is still there from the volume. Sendblue still points at the Railway webhook. A booking alert already delivered is not sent again |
| H11 | Disconnect Google Drive in Grok, or leave Drive unavailable, and send another text | The tour still proceeds. Backup status can show a failure or that a backup is due. The booking is not rolled back |

## I. Hosted demo reset

A development reset of the single hosted demo. Automated tests do not call
Railway, Sendblue, or Google. This section is the real service.

### A. Existing demo

Tour Core already has a published property, a completed tour, Sendblue,
operator updates, a Google Drive backup destination, and a Grok owner.
Backup files are already in Google Drive under Tour Core/Backups, Exports,
and Properties.

### B. Current Grok Bot

| # | Do | Expect |
| --- | --- | --- |
| I1 | Say "Reset this hosted Tour Core demo so I can run a fresh onboarding test." | Grok calls `reset_hosted_demo` with no confirmation code. Tour Core explains what will be erased and what will be kept (the Railway service, the stable URL, and Google Drive files). Nothing is deleted yet |
| I2 | Say "Yes, reset it." | Grok calls `reset_hosted_demo` with the confirmation code. The reset succeeds. Grok says this connection is no longer authorized and that you can delete this Bot. It does not delete Railway, the data volume, or Drive files, and it does not run a shell command |

### C. After the reset

| # | Do | Expect |
| --- | --- | --- |
| I3 | Open `https://<domain>/healthz` | `200`. The domain is unchanged |
| I4 | Look in Google Drive | Tour Core/Backups, Exports, and Properties, and the files inside them, are still there |
| I5 | Delete the current Grok Bot | The old connection is not reused |

### D. New Bot

Use the standard hosted bootstrap prompt (`GROK_BOOTSTRAP.md`, with
`hostedTourCoreUrl` set).

| # | Do | Expect |
| --- | --- | --- |
| I6 | Say "Set up Tour Core." | Grok finds the hosted service. It does not start a local runtime |
| I7 | Authorize and click Allow | The new Bot becomes the owner. No properties are listed. Visitor texting is not connected. The Google Drive backup destination is not configured. Operator updates are not configured |
| I8 | Continue the normal hosted onboarding | Choose a messaging provider, then Grok's Google Drive connector, then the first property, updates, readiness, practice, and publish. No old property or tour appears |
