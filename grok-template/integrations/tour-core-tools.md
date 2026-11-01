# Tour Core tools (custom MCP connector)

The Tour Core Bot's landlord connector is Tour Core itself, reached as a custom
remote MCP server:

- **Landlord URL:** `PUBLIC_BASE_URL/mcp` (hosted: the service URL + `/mcp`)
- **Ops URL:** the same origin + `/mcp/ops`, bearer `TOURCORE_OPS_TOKEN`. Off until that secret is set.
- **QA URL:** the same origin + `/mcp/qa`, bearer `TOURCORE_QA_TOKEN`. Off until that secret is set.
- **Transport:** Streamable HTTP (stateless, JSON responses)
- **Landlord auth:** OAuth, or the existing static `TOURCORE_OPERATOR_TOKEN` when that mode is on. A saved landlord token keeps working. Ops and QA do not use that token.

Custom MCP servers don't travel with Grok Bot templates, so every installer
connects the landlord connector after adding the Bot (see `docs/grok-template-setup.md`).
Add the ops and QA connectors only on the computers that should have them.

The landlord list is the tools below. Run `npm run grok:tools` to print it.
Every tool validates its input and calls the same Tour Core actions as the browser app.
Kinds: **read** changes nothing; **change** edits setup or records through Tour Core's normal rules;
**consequential** returns a yes/no question first and acts only when called again with the code after the operator's yes.

The older tools are not on these connectors. A Tour Core tool that isn't on the landlord list is refused with "That's no longer something I can do from this chat. Disconnect and reconnect Tour Core so I'm working from the current list, then ask me again." A name that isn't a Tour Core tool at all gets `There's no Tour Core tool called "${name}".` The ops and QA connectors say "The ops connector can't run that tool." and "The QA connector can't run that tool." Each connector advertises `tools.listChanged` and sends `notifications/tools/list_changed` on the SSE stream after `notifications/initialized`, so a connector that still shows the old list can re-fetch. `get_installation_status` on the QA connector includes `technical.commit` (the full deploy SHA, or `unknown`). The landlord connector does not.

## Landlord connector

| Tool | Kind | What it does |
| --- | --- | --- |
| `get_state` | read | What is done, what is stuck, and the one next step. Call this first |
| `save_property` | change | Saves the property address, type, time zone, name, facts, help number, alert contact, building access, and entry instructions. A street with no state or ZIP leaves the time zone unset. Changing only the state still checks a ZIP already saved. A mismatch asks which to fix and saves nothing |
| `save_units` | change | Adds, renames, or updates units and their leasing details. Say the `place`, never Main Home |
| `save_doors_and_routes` | change | Saves doors and walking routes, or with preview true only shows the matched route |
| `save_hours` | change | Saves touring days and hours from everyday words. Different days can have different hours (weekdays 9am-5pm, weekends 9am-8pm): one call per set of days. Once hours are saved, new days are added and the other days keep their hours; `replace` only when the host says to replace them all. Tours have to end later the same day. Tours must last 15 minutes to 4 hours, and starts must be 15 minutes to 8 hours apart |
| `save_settings` | change | Saves the basic identity form (recommended) or no form, plus tour-update choices. No form asks first, because anyone who texts could book and get in without saying who they are |
| `set_up_texting` | change | Sets up texting for this install (the provider, the line, and the check). The landlord chooses the provider here |
| `run_checks` | change | Runs the readiness check and a practice tour, including the connection, door-access, and alert self-tests |
| `publish` | consequential | Publishes the property for demo after a yes to the confirmation it returns |
| `remove_property` | consequential | Removes a property after a yes |
| `get_tours` | read | Tours happening now and tours coming up |
| `schedule_tour` | consequential | Books a one-off tour after a yes |
| `cancel_tour` | consequential | Calls off a tour after a yes. Destructive hint |
| `hold_tour` | consequential | Holds a tour after a yes |
| `pause_tours` | consequential | Pauses or resumes tours for a property or unit after a yes (`paused` true or false) |
| `get_inbox` | read | What needs the landlord, including a tour-update event id. Each item that had an alert includes its eventId. When the visitor has no name, the summary starts Visitor at {number}, {place}:. A named visitor stays their first name. The ping stays ids only |
| `reply_to_time_request` | consequential | Answers a requested tour time after a yes |
| `resolve_issue` | consequential | Handles an open issue. Show `visitorWillReceive` before a yes |
| `export_records` | read | A day's tour records as a validated export. Each embedded tour keeps only that day's events and grants. Practice-tour denials are counted apart from visitors who were turned away. |
| `backup_records` | change | Portable backup: create, confirm the destination, confirm it was stored, status, or decline. On a hosted install, a decline says operational records stay with hosted Tour Core. When records are already on this computer, or Google Drive is still waiting for approval, it says your records stay on this computer and portable backups stay off until Google Drive is connected. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. The result field `checksumCovers` is prefixed `For you, not out loud: ` and is not read aloud |
| `restore_records` | consequential | Upload, preview, or import a backup. Import asks first. Destructive hint. An upload whose declared size is over the cap is refused and the connection is cut after at most 1 MB. The checksum is the SHA-256 of the backup's `contents` only: compact JSON (no spaces), object keys sorted at every level, arrays kept in order, UTF-8 with non-ASCII characters written as-is (not \u-escaped), no trailing newline. It is stored in the file's `checksum` field, so a hash of the whole downloaded file won't match. The result field `checksumCovers` is prefixed `For you, not out loud: ` and is not read aloud |

`c = json.load(f)["contents"]`
`hashlib.sha256(json.dumps(c, sort_keys=True, separators=(",",":"), ensure_ascii=False).encode("utf-8")).hexdigest()`

`reset_hosted_demo` is added for the current hosted owner only. It is not offered on a self-hosted or local Tour Core. It does not take a file path and it does not run a shell command.

## Ops connector

Needs `TOURCORE_OPS_TOKEN`. A landlord token cannot list or call these.

| Tool | Kind | What it does |
| --- | --- | --- |
| `discover_storage` | read | Finds an existing records store this install can take over |
| `takeover_storage_writer` | consequential | Takes over as the writer for that store. Destructive hint |
| `prepare_storage_migration` | read | Checks a move onto Google Drive before it starts |
| `migrate_storage_to_google_drive` | change | Copies records onto Google Drive |
| `verify_storage_migration` | read | Checks the copy |
| `activate_google_drive_storage` | change | Starts using the copied records |
| `disconnect_google_drive_storage` | consequential | Disconnects Google Drive storage. Destructive hint |
| `get_storage_status` | read | Where records live right now |
| `get_storage_location` | read | The folder those records use |
| `begin_google_drive_connect` | change | Starts Google's approval so Tour Core can save records there |
| `finish_google_drive_setup` | change | Finishes that approval |
| `check_runtime_health` | read | When records aren't on permanent storage: Whether this Tour Core is healthy. Whoever set up your Tour Core hosting needs to attach permanent storage. Until then, hold off on updating Tour Core. |
| `check_public_endpoint` | read | Whether the public address reaches this installation |

## QA connector

Needs `TOURCORE_QA_TOKEN`. A landlord token cannot list or call these. Startup instructions on this connector call `get_installation_status` first. The last column is the landlord tool for the same check, or Stays on QA when that tool stays on this connector. `run_checks` stops when the connection isn't ready, so it cannot stand in for `test_operator_alerts` or `run_dry_tour`.

| Tool | Kind | What it does | Landlord tool for the same check |
| --- | --- | --- | --- |
| `inject_local_sms` | change | Sends a visitor text on the local loopback. Leave `property` out to use the shared line and not name a place | Stays on QA |
| `read_local_outbox` | read | Outbound local replies as separate bubbles | Stays on QA |
| `use_local_demo_storage` | change | Keeps records on this computer for a demo | Stays on QA |
| `list_exceptions` | read | The issue queue | `get_inbox` |
| `inspect_exception` | read | One issue, when you pass its id | `get_inbox` |
| `resolve_exception` | change | Closes one issue | `resolve_issue` |
| `test_operator_alerts` | change | Sends one tour-update self-test | Stays on QA |
| `begin_restore_upload` | change | Opens a short-lived restore upload | `restore_records` |
| `preview_portable_restore` | read | Checks an uploaded backup and changes nothing | `restore_records` |
| `import_portable_backup` | consequential | Restores a previewed backup after a yes. Destructive hint | `restore_records` |
| `schedule_one_off_tour` | consequential | Books a one-off tour after a yes | `schedule_tour` |
| `resume_tours` | consequential | Resumes bookings. On the landlord connector, pass paused false | `pause_tours` |
| `revoke_tour_access` | consequential | Calls off one tour after a yes. Destructive hint | `cancel_tour` |
| `run_dry_tour` | change | Runs a practice tour | Stays on QA |
| `get_installation_status` | read | What is set up, component by component. Call this first on this connector. On this connector, technical.commit is the full deploy SHA, or unknown | Stays on QA |

There is intentionally no tool to open, unlock or grant a door, mint access,
change the door-access mode, or read or write raw files. There is also no
tool that sets an API key, sender key, webhook secret or any other
credential, and none that runs a shell command: credentials are collected
with a secure secret input and written by filling Tour Core's setup form, and runtime management (install, start,
restart) is done by Grok in its own terminal with `npm run bootstrap:grok`
and `npm run service:*`.
