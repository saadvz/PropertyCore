# Tour Core Bot for Grok Bot: setup, template and install

This guide builds the **Tour Core** Bot in Grok Bot, connects it to your Tour
Core, publishes it as a **team-only** template, and installs it from that
template. It uses the Grok Bot features xAI documents today (Bots, profile,
private skills, custom MCP servers, approvals, templates). Where the Grok Bot
app has more than one way to do something, both are given.

Everything the Bot knows about properties and tours comes from Tour Core's
tools. Tour Core keeps working without Grok: the browser app (`npm run setup`)
and the terminal wizard (`npm run setup:cli`) use the same actions.

**Recommended P0 path: Grok-managed.** Once the Bot exists (steps 3, 4 and the
routine below), the operator just says *"Set up Tour Core."* The Bot installs
Tour Core on its own cloud computer (`npm run bootstrap:grok`), connects to it,
and collects credentials with Grok's secure secret input. Steps 1, 2 and 5
below are then done by the Bot, not by hand. See
[`deployment.md`](deployment.md). The manual steps stay here for self-hosted
and developer installs.

---

## 1. Prerequisites

**Grok Bot**

- The Grok Bot desktop app (macOS or Windows; the iOS app can use the Bot once
  it exists, but some management is desktop-only).
- A plan that includes Grok Bot (SuperGrok Plus or Heavy, or an eligible Cursor
  plan) and the Cursor account Grok Bot signs in with.
- For team-only templates: you and the installers are on the same team.

**Tour Core computer** (the machine that runs Tour Core)

- Node.js 20+, this repository, `npm install`.
- Real texting set up as in the README's "Real phones with Sendblue" section:
  `.env` with the Sendblue values, a secure tunnel, `PUBLIC_BASE_URL` set to the
  tunnel's https address, and `npm run sendblue:configure` done.
- Grok Bot runs in the cloud, so it can only reach Tour Core through that
  public https address. `localhost` won't work.

## 2. Check the Tour Core connector is on

The connector uses OAuth by default; there's no token to create or copy.
On the Tour Core computer:

1. Make sure `.env` has **no** `TOURCORE_MCP_AUTH_MODE` line (or has
   `TOURCORE_MCP_AUTH_MODE=oauth`). `static` is a development mode; see the
   end of this guide.
2. Start the tunnel, set `PUBLIC_BASE_URL` to its https address, and start
   Tour Core (`npm run setup`). The startup lines include
   `Grok Bot connector: https://<your-tunnel>/mcp (OAuth: approve connections at http://localhost:4321/grok)`.
3. `npm run grok:connect` prints the URL to give Grok.

What that endpoint is: a thin MCP bridge (Streamable HTTP) mounted on the
existing Tour Core server. It lists Tour Core's operator tools and hands each
call to the same actions the browser uses. It has no business or policy logic
of its own. It's protected the way the MCP authorization specification
describes. An unauthenticated request gets `401` with a pointer to
`/.well-known/oauth-protected-resource/mcp`, which names Tour Core itself as
the authorization server (`/.well-known/oauth-authorization-server`). Grok
registers (`/register`), sends you to `/authorize`, and exchanges the approval
for a short-lived token (`/token`, PKCE S256). Through the tunnel address,
`/mcp` and those OAuth addresses are the only operator routes. The browser app,
and the page where you approve connections, answer only on this computer.

`npm run grok:status` shows the mode, the URL and what's connected (never token
values). `npm run grok:tools` lists the 22 landlord tools. The hosted owner
also sees `reset_hosted_demo`. The ops connector lists its 13 tools and the
QA connector lists its 15. Those connectors are separate from the landlord list.

## 3. Create the Tour Core Bot

1. In Grok Bot, choose **New** (Cmd/Ctrl+N) → **Create new agent**.
2. **Bot actions → Edit Profile**: set the **name**, **title** and
   **description** from [`grok-template/bot-profile.md`](../grok-template/bot-profile.md).
3. In the Bot's conversation, paste the **Standing instructions** section from
   `bot-profile.md` and ask: *"These are your standing instructions as the Tour
   Core Bot. Keep them."*
4. Attach the five files in `grok-template/context/` and the two in
   `grok-template/examples/` and ask the Bot to keep them as reference for this
   role.

## 4. Add the seven skills

The skills live in [`.grok/skills/`](../.grok/skills/). For each of the seven
folders:

1. Attach (or paste) its `SKILL.md` in the Bot conversation.
2. Ask: *"Save this as a skill called Setup Property. Keep the instructions,
   the allowed tools, the approval rules and the stop condition exactly as
   written."* (Use the matching name: Install Tour Core, Setup Property, Map
   Route, Run Readiness Check, Work Exception, Export Audit, Backup Tour Core.)
3. Review what the Bot saved; it should match the file.

### The Tour Core Operator Updates routine

You don't create this by hand. When the operator turns on tour updates (after
the first property is saved), the Bot creates a routine named **Tour Core
Operator Updates** with an **authenticated webhook** trigger and the
instructions in
[`grok-template/routines/operator-updates.md`](../grok-template/routines/operator-updates.md),
then asks for the webhook address and sender key with a secure secret input
and submits Tour Core's form. If that input cannot be used, and both values
stay hidden behind copy buttons, the Bot may paste them into the masked
fields without reading them. If a value is shown on screen, the operator
copies both values, or pastes the routine's whole webhook example. They never
go in chat, tool arguments, files or commands. (Rotate the key first if it
has been shown anywhere else.) If you're building the Bot by hand for a
self-hosted install, you can create the routine the same way and use the
setup page as the manual fallback.

Private skills are one library shared by your Bots. If one doesn't appear in
the `/` menu, open **Marketplace → Your plugins → Manage plugins and skills**
and check it's listed under **Private skills**.

## 5. Connect Tour Core (custom MCP server)

Custom MCP servers are account-level connections and are **not** copied into
templates, so this step is repeated by every installer.

1. Go to **grok.com/connectors** (or the connectors/integrations screen in the
   Grok Bot app), choose **New Connector → Custom**, and enter
   `https://<your-tunnel>/mcp`. Name it Tour Core. Leave any token, header or
   client ID/secret fields **empty**; Grok registers itself.
   (From the Bot's conversation instead: *"Add this MCP server:
   https://&lt;your-tunnel&gt;/mcp. Name it Tour Core. It uses OAuth."* Check
   the URL it shows and confirm.)
2. Grok opens a **Tour Core** page: "Grok is requesting permission to manage
   this Tour Core installation", what it can and can't do, and a six-digit
   code.
3. On the Tour Core computer a **Connect Grok** window opens by itself (or
   open `http://localhost:4321/grok`). Check it shows the **same code**, then
   click **Allow**. (**Deny** on either page refuses.)
4. The Grok page returns to Grok, which shows Tour Core as connected.

You never paste a Tour Core credential anywhere. Approval only works at the
Tour Core computer while Tour Core is running; the public page can only deny.

Grok gets a one-hour access token for Tour Core's operator tools (scope
`tourcore.operator`). If it registered for refresh tokens, it can renew
itself: each refresh token is single-use, lasts up to 30 days, and an approval
ends after 90 days at most. Then you approve again.

New tools are available from your next message. Check with *"List the Tour Core
tools you can use."* You should see tools such as `get_state`,
`save_property`, `run_checks`, `get_inbox` and `export_records`, and nothing that
unlocks a door.

**Approvals.** Grok Bot asks for approval around consequential actions and lets
you add **Require approval** rules. Add one for the Tour Core tools
`publish`, `remove_property`, `cancel_tour` and `restore_records`. On a hosted Tour Core
the owner also approves `reset_hosted_demo`. Tour Core enforces its own
approval regardless: those tools only act when called a second time with a
short-lived code after the operator's yes, and only if nothing changed.
Connecting with OAuth doesn't change that. OAuth only decides whether Grok may
call the tools at all.

**Disconnect Grok.** Click **Disconnect Grok** on `http://localhost:4321/grok`,
or run `npm run grok:disconnect`. Every Grok token stops working at once, even
in a running Tour Core. Properties, tour history, texting settings, visitor
sessions and door access settings are unchanged. To connect again, reconnect Tour Core in
Grok and approve.

**If the tunnel address changes** (a new `trycloudflare.com` URL): in a
Grok-managed install the bootstrap records the new address and the
installation status marks Grok's connection and visitor messaging as needing
action. Otherwise update `PUBLIC_BASE_URL` and restart Tour Core. Either way,
remove the Tour Core connector in Grok and add it again with the new URL, then
ask the Bot to check texting (`set_up_texting`) so the texting provider
gets the new address. Tokens and registrations are tied to the address they
were issued for, so the old ones stop working by design.

**If Grok says the connection failed during registration**, look at the Tour
Core window. If the refused redirects are `scheme=cursor host=anysphere.cursor-mcp`
and/or `host=www.cursor.com path=/agents/mcp/oauth/callback`, that's Grok Bot's
current Cursor-based client. On `HOSTED_RAILWAY_P0` those exact callbacks are
already accepted; `TOURCORE_GROK_LEGACY_OAUTH_COMPAT=false` is what turns them
off. On a local or self-hosted install, follow "P0 only: Grok legacy OAuth
compatibility" in [`grok-manual-test.md`](grok-manual-test.md) instead of
adding hosts.
Otherwise, a `refused redirect: scheme=https host=<host> ...` line means Grok
used a return address on a host Tour Core doesn't allow yet. By default only `grok.com`, `x.ai` and `x.com` (and their
subdomains) are allowed. If that host is really Grok's, add it to `.env`
(`TOURCORE_OAUTH_REDIRECT_HOSTS=<host>`), restart, and connect again.

## 6. Confirm nothing secret is in the Bot

Before sharing, check the Bot's profile, instructions, memories and skills for:

- Sendblue API key, API secret or webhook secret
- any Tour Core token or `Bearer` value (with OAuth you never had one to paste)
- visitor names, phone numbers or emails from real tours
- real property records or tour history you don't want to share

`npm test` checks the template files in this repo for these. Anything you typed
into the Bot yourself is up to you to review.

## 7. Run "Set up a property"

Type `/` and pick **Setup Property**, or just say *"Set up a property"*. The Bot
asks one question at a time (address, then "What type of property is this?",
units or the whole home, unit details, entrance, hallway doors, routes, tour
hours, verification), shows what it inferred, and reads the setup back. The
address is the property's name unless you give one; the Bot never invents a
building name. On a fresh install the Bot asks "How should people text you about a tour?"
and calls `set_up_texting`. Once texting is installed, a new property uses it
automatically, so the Bot doesn't ask that again. See
[`grok-template/examples/first-run.md`](../grok-template/examples/first-run.md).

## 8. Run readiness

Say *"Is it ready?"* (Run Readiness Check). The checklist comes straight from
Tour Core's readiness engine; failures come back in plain words with a fix.

## 9. Run a practice tour

Say *"Run a practice tour"* (Run Readiness Check). `run_checks` runs the
readiness check and the practice tour. Nobody is texted and no real door
opens. The Bot lists the proof points.

## 10. Publish

The Bot asks *"Everything passed. Do you want me to publish 100 Alfred Way for
demo?"* Only a clear yes publishes, and only if readiness and the practice tour
passed for this exact setup. "Published for demo" is not a production launch:
the Bot says "Visitor texting is live. Door access is still in demo mode, so no
physical locks will open."

## 11. Show active tours

After a visitor texts the property number: *"Show active tours"*, then *"What's
happening with Pat's tour?"*

## 12. Work one exception

Have the visitor ask something the approved facts don't cover. Then: *"What
needs attention?"*, *"Open Pat's issue."*, and give the answer (*"Yes, parking
is included."*). The Bot offers to add it as an approved fact and text Pat, and
does so only after your yes; Pat then carries on from the step they were on.
With tour updates on, the Bot tells you about the question (and about
bookings, tour starts and completions) without being asked.

## 13. Export the audit

*"Export today's audit."* The export is written and validated on the Tour Core
computer; the Bot gives the day's summary and where the file is.

---

## Publish the Tour Core template (team-only, P0)

Publishing is manual. There's no official API for it, and P0 doesn't need one.

1. Open the Tour Core Bot's settings and choose **Share as template** (or ask
   the Bot to create a shareable copy of itself). Nothing goes live yet: Grok
   Bot prepares an unpublished, anonymized template.
2. **Review what's included**: instructions, selected memories, the seven
   skills, the Tour Core Operator Updates routine definition, and integrations. Remove anything personal, any real visitor or property
   data, and anything that looks like a credential. Custom MCP servers and
   secrets aren't copied; confirm the Tour Core connector isn't listed as
   included.
3. Ask the Bot: *"Review the template you just created. Add setup instructions
   for the Tour Core MCP server: it must be added from chat with this
   repository's docs/grok-template-setup.md, step 5."*
4. Choose **Team** visibility.
5. **Publish**, then **Copy Link**.
6. Share the link with your team.

## Install from the template

1. Open the link. The template page shows the Bot's context and integrations.
2. Choose **Add to Grok Bot** (it may read **Open in Grok Bot**). The app opens
   the template for review.
3. Review the **context and integrations**; it should match
   `grok-template/template.json` and include no secrets or live data.
4. Choose **Add Bot**. You get your own independent copy.
5. Say *"Set up Tour Core."* The Bot installs and connects its own Tour Core
   and asks you only for what needs a person: approvals, logins, and
   credentials through Grok's secure input. No
   webhook secrets, provider secrets, Tour Core OAuth tokens or live property
   data come with the template. (Self-hosted instead: do steps 2 and 5 above
   with your Tour Core's URL.)
6. Run one safe task (*"What's left to set up?"*, then *"Run a practice
   tour"*) before anything consequential.

## Limits to know about

- Grok Bot has no public API, so there is no automated end-to-end test against
  a real Bot; `npm test` covers the tool contract, bridge, skills and template
  without an account. Use [`docs/grok-manual-test.md`](grok-manual-test.md) for
  the real Bot.
- The skill files follow the `SKILL.md` format xAI documents for `.grok/skills`.
  Grok Bot saves skills inside the app, so they're added by attaching the file
  and asking the Bot to save it; review that the saved text matches.
- Custom MCP servers aren't part of templates. Every installer reconnects.
- xAI's connector docs say only "complete any required authentication"; they
  don't say how Grok registers as an OAuth client. Tour Core supports both
  ways the MCP specification defines: Dynamic Client Registration (what Grok
  was seen using) and Client ID Metadata Documents.
- Anyone who has the tunnel URL can *ask* to connect, which pops up a Connect
  Grok window here. Only allow a request whose code matches a page you opened
  yourself.

## Development only: static token mode

For scripts and troubleshooting there is a static bearer-token mode. It
replaces OAuth rather than adding to it: only one mode is on at a time.

```bash
npm run grok:connect -- --static            # creates TOURCORE_OPERATOR_TOKEN, sets TOURCORE_MCP_AUTH_MODE=static
npm run grok:connect -- --static --rotate   # replaces the token
```

Restart Tour Core. `/mcp` then accepts only `Authorization: Bearer
<TOURCORE_OPERATOR_TOKEN>`, and the OAuth addresses answer 404. Don't use this
with the real Grok connector, and never paste the token into a chat. To go
back, delete the `TOURCORE_MCP_AUTH_MODE` line from `.env` and restart.
