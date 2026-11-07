# Sign in and Create account on the connect page

Date: 2026-11-07. Status: draft, for review with Saad.
Issue: saadvz/TourCore#162, part of saadvz/TourCore#158 (Phase 0). Builds on
the number pool (saadvz/TourCore#163) for the new account's text line, and
hands the verified phone to per-account texting consent (saadvz/TourCore#164).

## Goal

A host nobody has spoken to adds the connector in their chat, and the page
that opens lets them create an account and Allow, with no `/admin` step. A
host who already has an account signs in on the same page.

## The page

On the multi-tenant service, with sign-up open, the Allow page offers three
choices, one at a time:

- **Sign in** (the default): mobile number, "Text me a code", the code, Allow.
- **Create account**: the same phone and code, plus email and "I accept the
  terms" (a link to Saad's terms page), then Allow.
- **I have an invite code**: the invite field, as today.

The shared address's service pick still shows under all three. With sign-up
off, the page is the invite-only page it was.

## What happens on Allow

- **Sign in.** The code is checked first. Then the grant binds to the account
  whose landlord signed up with that phone. A phone with no account is told
  to choose Create account, and a turned-off account is refused.
- **Create account.** Email and terms are checked before the code, so a
  missing tick doesn't spend it. After the code checks out, a phone that
  already has an account is told to sign in. Otherwise the pool's
  `openAccount` creates the account with a ready number and points its
  webhook; an empty pool refuses with "No text lines are free right now".
  The account then records its landlord:
  `owner: { phone, email, phoneVerifiedAt, terms: { version, acceptedAt } }`.
  The grant binds to the new account.

Whether a phone has an account is said only after its code checks out, so the
page can't be used to learn which phones are signed up.

## The phone code

Twilio Verify sends and checks it (`CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID`,
on the shared Cleaner Core Twilio account). The service never stores a code,
and it needs no registered line of its own to text from, since Verify's
senders are already registered. Only US and Canadian numbers are taken, the
same as the text lines.

## Limits

Kept in the service process, beside the approval requests they belong to.
Twilio Verify keeps its own per-phone limits as well, so a restart still
leaves a cap.

| Limit | Value |
| --- | --- |
| Codes per phone | one every 30 seconds, five an hour |
| Codes per connect page | five |
| Codes for the whole service | 200 an hour |
| Wrong codes | five in an hour locks that phone out for an hour |
| A code check | only for a phone this page sent a code to |

## Turning it on

All four, or the page stays invite-only:

| Variable | Value |
| --- | --- |
| `CLEANER_CORE_SIGNUP` | `1` |
| `CLEANER_CORE_TWILIO_VERIFY_SERVICE_SID` | The Verify service (`VA…`) |
| `CLEANER_CORE_TERMS_URL` | Saad's terms page, `https://` |
| `CLEANER_CORE_TERMS_VERSION` | The version a new account records, such as `2026-11-07` |

The number pool must have ready numbers.

## Invite codes

They keep working beside sign-in. An account made in `/admin` has no
landlord phone on file, so turning invites off would leave those hosts
unable to reconnect.

## Not yet

- A landlord on an admin-made account can't claim it by phone yet; they keep
  using invite codes.
- Changing an account's phone or email.
- Closing an account from the chat.
