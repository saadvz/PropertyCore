# Ring account linking: the Token Exchange and Account Link addresses (#302)

Ring's portal won't let any Ring account connect to the private app until its Account linking form is saved, and the
form needs two addresses the service didn't have. This adds them, so the one-week counting test (#239) can start.

Ring's documentation was reread on 25 Nov 2026 (developer.amazon.com/docs/ring/: api-documentation.html,
configure.html, developer-faq.html). Three findings shaped this:

- **The link built in #267 can't be used.** Starting from our side with PKCE is what Ring calls partner-initiated
  linking. It is by invitation only, and an app uses one method, never both. The private app is on the Ring-started
  method, "one-way account linking".
- **Two more calls to Ring are needed.** After the nonce check, the nonce goes back to Ring
  (`POST /v1/accounts/me/app-integrations`), then the link is marked completed (`PATCH`, same address). Without
  them Ring shares no cameras and sends no events.
- **Ring requires the host to be signed in to our side before their tokens are kept**, and the identity must never
  come from a value the browser sends. A host has no web sign-in here: they are known only through their
  assistant's chat. So the sign-in is something that chat hands them.

## Decisions (approved 25 Nov)

1. **Matching a host arriving from Ring: the browser's mark, with a pairing word as the fallback.** The one-time
   link from the assistant is the host's sign-in. Agreeing on its consent page marks that browser for 30 minutes and
   shows a pairing word. Same browser on return: a Connect button and nothing to type. Another browser: the page
   asks for the word. Considered and not chosen: the mark alone (strands a host whose Ring app opens another
   browser), the word alone (everyone types), and Ring's "passwordless" match on the Ring account's email (the
   emails can differ, it would link without the host asking in chat, and it skips consent for a named property).
2. **#267's PKCE flow does not work for the private app**, so the two new routes carry the whole link. The consent
   page stays; its button no longer redirects to Ring. `/cameras/ring/linked` and the PKCE code are removed. Asking
   Ring to allowlist the app for partner-initiated linking can come later without undoing this.
3. **Scopes: Cameras and Doorbells only.** The four sensor groups are turned off in the portal, and Chimes stays
   off. A portal change, not code.

## How linking works

1. `connect_cameras` returns a one-time link, good for 30 minutes.
2. The host opens it, reads what is read, and agrees. Consent is recorded for that property, the browser gets a
   cookie tied to the link, and the page shows the pairing word and says to connect Property Core in Ring.
3. In Ring, the host approves access and picks cameras. Ring posts `code` and `client_id` as a form to
   `POST /cameras/ring/token`.
4. A client id that isn't ours gets a 400 and nothing else. Otherwise the code is traded at Ring inside its 60
   seconds, the Ring account id and email are read from `GET /v1/users/me`, and the tokens are held as waiting.
   Then 200. Any failure answers non-2xx, which fails the link at Ring.
5. Ring sends the host's browser to `GET /cameras/ring/link?nonce=…&time=…`.
6. A `time` over 600 seconds old, or more than 30 seconds ahead of our clock, is refused. The waiting tokens are
   the ones whose Ring account id gives that nonce: `HMAC-SHA256(key, "<time>:<account id>")`, URL-safe base64, no
   padding, with the app's HMAC Signature Key (`RING_WEBHOOK_SECRET`). No match: "not connected".
7. The page shows the Ring account's email, partly masked, and a Connect button. A marked browser also sees the
   property's name. An unmarked one is asked for the pairing word.
8. On Connect (a POST, so the same checks run again): the nonce goes to Ring, the link is marked completed, the
   one-time link is used up, the tokens are sealed into that account's secrets, and `cameras.json` gets
   `connectedAt`. If Ring refuses the nonce, nothing is saved and the host starts again from the chat.

## Routes

| Portal field | Address | |
| --- | --- | --- |
| Token Exchange URL | `POST /cameras/ring/token` | New |
| Account Link URL | `GET`, `POST /cameras/ring/link` | New |
| App Homepage URL | `GET /cameras/ring` | New: the connection is managed from the assistant's chat |
| Webhook URL | `POST /webhooks/ring` | Built in #267 |

## Rules

- Every route answers 404 unless Ring's three secrets are set and some account has Cameras on. The token and link
  addresses also need `CAMERA_TOKEN_KEY`.
- The Token Exchange route does nothing for a client id that isn't ours, and reads the body as a form, never JSON.
- No token, secret, code, nonce, pairing word or response body goes in an error or a log. Tokens never reach the
  browser. The Ring email is shown masked and never put in an address.
- Tokens are saved to an account only after the nonce matches, `time` is fresh, the host is matched by the mark or
  the word, and Ring has checked the nonce.
- Nonce, mark and word comparisons take the same time whether they match or not.
- The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/cameras/ring`, so it rides Ring's redirect but no
  cross-site POST.

## Builder's calls

- Waiting tokens are sealed with `CAMERA_TOKEN_KEY` and kept in memory only, for 15 minutes. A restart inside that
  window means the host starts again, as with the one-time links.
- The pairing word is 8 letters shown as two groups of 4: no digits, no vowels, no look-alike letters. Five wrong
  tries drop the waiting tokens.
- A second link for a Ring account already waiting keeps the newest tokens, as Ring's documentation says.
- The name Ring shows the host for our side (`account_identifier`) is the account's label, partly masked.

## Tests

Fake provider and a stubbed fetch only; nothing calls Ring. The full link in a marked browser; the link by pairing
word; five wrong words; a stale and a future `time`; a nonce for no waiting tokens and for another Ring account; a
foreign client id, a missing code and a JSON body; Ring refusing the code; Ring refusing the nonce; waiting tokens
expiring; a mark from a switched-off account; 404 without the secrets or the key; and no token or code in a log.

## Not in this change

Acting on `app_integration_removed` beyond today's log line: once a host removes the app, Ring refuses the tokens
and the assistant already says to connect again.

## For a person, after deploy

1. `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_WEBHOOK_SECRET` and `CAMERA_TOKEN_KEY` on Railway, and Cameras on
   for the test account on /admin. The routes answer 404 until then, so this comes before the portal's check.
2. In Ring's portal: turn off the four sensor groups, save the four addresses under Account linking, and run
   Test > Validate account linking if the private app shows it.
3. In Connect, Log in with Ring as the tester's Ring account, which needs a Ring plan or trial.

Open, to confirm on the live portal: where a host starts in Ring for a private app (the consent page's wording
follows), and whether Ring's validation check needs a real host session on our side.
