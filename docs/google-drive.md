# Google Drive and hosted storage

Tour Core keeps its own records. Grok installs Tour Core and explains it.
For `HOSTED_RAILWAY_P0`, Google Drive is a portable backup and export copy.
It is not the live operational store.

```
Grok
  ├── Tour Core MCP          hosted Tour Core
  │                            └── Railway volume /data   live operational state
  └── Google Drive connector   the user's Drive
                                 └── Tour Core/            backups and exports
```

A normal hosted user authorizes Google once, through Grok's built-in Drive
connector. Tour Core does not start a second Google approval, and it does not
need `TOURCORE_GOOGLE_WEB_CLIENT_ID` or `TOURCORE_GOOGLE_WEB_CLIENT_SECRET`.

## What is live

`HOSTED_P0_VOLUME` is the hosted P0 storage model. The Railway volume at
`/data` (`TOURCORE_HOME`) holds property state, reservations, sessions,
ledgers, the operator outbox, exceptions, and secrets. A restart or redeploy
reads that volume. It does not restore from Drive.

Drive is not on the path for an inbound text, a booking, a reservation change,
an access decision, a custom time, an exception, or session recovery. Tour
Core does not wake Grok in order to save a booking. If Grok is idle or Drive
is down, tours continue. A failed backup is recorded and does not roll back a
tour.

## What Drive is for

After Sendblue, Tour Core recommends Drive. Grok connects its own connector,
creates or finds a private folder named `Tour Core`, with `Backups/`,
`Exports/`, and `Properties/`, and calls `backup_records` with `confirm_destination`. No
OAuth token is passed. Tour Core records that the backup destination is
configured. It does not pretend to hold Grok's Google token.

The folder belongs to the user. Tour Core does not create public sharing links.

Backups are saved at checkpoints: after the first publish, after a structural
republish, after an approved content change, after a completed tour, when the
operator asks, and when `backup_records` with `status` says one is due. Not on every
transaction.

`backup_records` with `create` writes a validated snapshot and a short-lived
capability download. Grok uploads that file to `Tour Core/Backups` and then
calls `backup_records` with `confirm_stored`. Until that call, Tour Core does not say the
file is in Drive.

On an installation whose records live in Google Drive (`GOOGLE_DRIVE_READY`), the day's `audit-export.json` is written with the records and copied into Drive by the save step. The CSV stays on the Tour Core computer. On a hosted installation (`HOSTED_VOLUME`, Drive used only for backups), day exports stay on the server as 30-minute download links that can be used until they expire. Only readable exports and backups come back as one-time links for the assistant to save into the Tour Core folder in Drive. A readable export is not a backup. Door access in a day export is only what was issued or used that day. Each embedded tour in that JSON is trimmed to that day's events and grants.

## Portable snapshot

`tour-core-backup-2026-09-29T030000Z.json`

```json
{
  "format": "tourcore-portable-backup",
  "schemaVersion": 1,
  "installationId": "inst_...",
  "createdAt": "2026-09-29T03:00:00.000Z",
  "tourCoreVersion": "0.4.0",
  "contents": { "files": [] },
  "checksum": "..."
}
```

`contents.files` are the existing canonical JSON records: properties,
addresses, types, units, facts, content changes, doors, routes, schedules,
prospects, reservations, custom time requests, consent, verification status,
tour state, operator holds, exceptions, preferences, audit, operator-event
metadata, and visitor session state that is already stored. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. `c = json.load(f)["contents"]` `hashlib.sha256(json.dumps(c, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")).hexdigest()` The snapshot is
rejected unless that checksum, the schema, and the record relationships check out.

Portable backups can contain visitor details that Tour Core already stores.
They do not add extra personal data for the sake of the copy. The Drive
folder stays private.

Never included: Sendblue keys and webhook secrets, the Grok Routine address
and key, MCP tokens, Google tokens, hosted owner cookies, CSRF and setup
session secrets, door access credentials, and Railway secrets. Those are
reconnected after a restore.

## Restore

Grok downloads the latest backup and uploads it through a short-lived
capability (`POST` to the restore handoff, not a page). A backup up to 50 MB is accepted. The bytes are written
to a file as they arrive. An upload over that cap returns 413 with a plain
message that states the cap, which Grok can relay. An older ID check is named in the import summary: it now uses the basic identity form, and the landlord can ask for no form. Tour Core validates the
file, shows a plain preview, and waits for an explicit yes. Receiving the file
does not change live records.

P0 restore is for an empty installation, such as a volume that was lost.
If this Tour Core already has property or tour records, import is refused
unless the operator explicitly chooses replacement. Merge is not supported.

After restore, property and tour history are back. Visitor texting, operator
updates, and door access need their credentials again. The backup
does not contain them.

A normal Railway restart does not use this flow.

## Optional direct Drive

`DIRECT_GOOGLE_DRIVE` (`TOURCORE_STORAGE_MODEL=DIRECT_GOOGLE_DRIVE`) keeps the
older design: Tour Core's own Google OAuth client, refresh tokens in
SecretStore, `GoogleDriveStore`, and a writer lease. That mode can still be
used for self-hosted experiments and migration tools. It is not the hosted
onboarding path, and its lease does not block hosted setup.

Automated tests use a fake Drive client for that mode. They do not call Google.

## Later

Before a public multi-tenant marketplace, a real hosted database becomes the
operational store per tenant. Grok's Drive connector stays the user-owned
backup and export layer. This milestone does not add that database.

A daily Grok Routine that writes Drive is not shipped. Routines can call Tour
Core, but the Drive connector is what saves the file, and that happens in a
conversation. See `grok-template/routines/tour-core-backups.md`.
