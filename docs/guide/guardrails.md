# Guardrails

Zamfono is built so that a mistake, human or assistant, is cheap to make right. This is what
enforces that.

## Every write is audited

Every operation that changes configuration, destroys data or reveals a secret writes an `audit_log`
entry: who did it, on which channel (`rest`, `mcp`, `ui`, `undo`, `job`), what changed, field by
field. `audit.list` (`GET /api/v1/audit`) lists it, filterable by entity, actor, channel, operation
and time range (`from`, `to`; a time without an offset is the tenant's local time). Secret values
(passwords, API tokens, `*_enc` settings) are masked in the diff.

## Most changes are undoable

`audit.undo` (`POST /api/v1/audit/{id}/undo`) reverts one entry by writing its recorded values back.
It is refused, naming the conflicting row, when a later live change to the same entity exists, when
the change would recreate a duplicate (a reused extension, e-mail or DID number), when a revived row
would point at a row deleted since (undo that deletion first), or when the entry itself is not
undoable — a secret-bearing change, a one-shot action such as a manual backup run or a sent e-mail,
creating or revoking a personal access token, or a hard delete whose file is already gone. Only an
owner undoes the deletion of an admin or an owner; an admin gets 403. The entries of the six
operations that record what an effect outside Zamfono answered (`ringotel.push`, `ringotel.profile`,
`ringotel.roster`, `ringotel.rereg`, `system.autoUpdate`, `system.maintenanceGate`) are never
undoable and never block an undo. See the `undo` recipe for the full walk-through.

## Deletes are soft, then confirmed, then purged

`DELETE` on a config entity sets `deletedAt` rather than removing the row; the row stays reachable
for undo until `settings.softDeleteRetentionDays` passes. Every `DELETE`, plus `users.erase`
and `devices.rotate`, additionally requires an explicit confirmation: the first call without
`confirm: true` answers 409 with the question to ask a human ("Delete Anna Huber (extension
101)? …"); the retry with `confirm: true` performs it. Over MCP, a capable client (Claude Code,
Cursor, VS Code) asks this through elicitation instead of a second tool call; a client that lacks
it, or declines, falls back to the same two-call REST contract, at which point the client's own
permission prompt for a destructive tool is the human gate.

A soft delete is itself refused, listing the blocking references, while another live row still
points at it — a DID targeting the user, another group's fallback, the tenant main number. Retarget
those first, or promote another owner; there is always at least one live `owner`, who cannot be
demoted or soft-deleted.

## Role checks are the same everywhere

Every operation enforces its own `minRole` (`owner` > `admin` > `user`) once, so REST, MCP, undo and
the tenant UI share one answer for who may do what. A `user` reads and edits only their own scope —
their voicemails, their history, their devices, a handful of self-service settings (`clir`,
`rejectAnonymous`, `ringTimeoutS`, `notifyMissedCalls`, `findMe`, their own OOO and hours, their own
call forwarding, their own voicemail greeting). Of the calls in progress (`calls.list` with
`live: true`, the `call.state` events) a `user` sees one they placed, were called on or answered, or
that one of their phones rings or is connected in right now, and ends, transfers, holds or adds to
(`calls.hangup`, `calls.transfer`, `calls.consult`, `calls.hold`, `calls.addParty`) only one they
placed, while their own phone is in it, or are connected in (`call-control`), as they park one
(`calls.park`); every user sees the parked calls (`parking.list`), which only an admin ends.
Recordings are `admin`/`owner` only, including of a user's own calls. A `sip` target is admin-only
everywhere: a user's own forwarding, OOO rule or hours that names a new one is refused with 403. A
user whose forwarding an admin pointed at one reads their rules with `users.getForwarding`
(`GET /api/v1/users/{id}/forwarding`), in the shape `users.setForwarding`
(`PUT /api/v1/users/{id}/forwarding`) takes, and sends them back edited: the `PUT` replaces the
rules as a whole, keeps the admin's `sip` rule when it comes back unchanged under the same
condition, refuses it changed in any field or under another condition, and removes it when left out.

## Rate limits protect logins, not the API

Login, token, password-reset and client-registration endpoints carry per-account and
per-address limits; the rest of the API is not throttled beyond that. An account under repeated
failed logins locks for 15 minutes, without revealing whether the account exists.
