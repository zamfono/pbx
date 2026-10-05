# Glossary

**Extension** — the short internal number dialled between colleagues. A user, a ring group and a
parking slot each own one extension.

**Parking slot** — an extension that holds a parked call (`*70`) until someone dials it; replaced
as a set with `parking.set`. See `parking`.

**User group** — a named, nestable set of users, flattened wherever it is used: as ring-group
members and as an outbound route's callers. See `user-groups`.

**Contact** — a tenant-wide phone-book entry (`contacts`) whose numbers name inbound callers. See
`directory`.

**DID** — a phone number the tenant owns, routed on arrival to a forward target.

**Number block** — a base and the numbers that begin with it (`didBlocks`): a fixed count of
digits after the base, or, with `digits` `null`, any number of digits, none included. It groups
the DIDs within it and gives its numbers that no DID holds a fallback; it routes nothing itself.
See `numbers`.

**Main number** — the DID referenced by `settings.mainDidId`, presented as caller ID when neither
the outbound route nor the caller sets one. See `numbers`.

**Fallback** (inbound) — the forward target for a number no DID holds: the covering number
block's `fallbackTarget`, else the tenant-wide `settings.fallbackTarget`, else a 404 release. See
`numbers`.

**Forward target** — the eight-kind vocabulary (`user`, `ringGroup`, `external`, `sip`,
`mailboxUser`, `mailboxRingGroup`, `announcement`, `menu`) every routing rule points at. See
`mental-model`.

**Hop** — one re-entry of the routing pipeline through a `user` or `ringGroup` forward target. A
call is released to a mailbox after the third hop.

**OOO rule** — an out-of-office rule for a scope (user, ring group, menu or tenant), with an
optional start and expiry and a forward target, evaluated ahead of opening hours.

**Opening hours** — a weekly schedule of open intervals per scope, with a closed target for
everything outside them.

**Feature code** — a `*`/`#`-prefixed dialled string handled in Stasis rather than by ringing
anyone: pickup (`*8<ext>`), DND on/off (`*90`/`*91`), mailbox access (`*95<ext>`, `*96`),
deposit (`*97<ext>`), add a third party (`*5<target>`), CLIR override (`#31#`/`*31#`), park
(`*70`). Codes are remapped tenant-wide in `settings.featureCodes`.

**Attended transfer** — a transfer after talking to the target first: the other party waits on
hold while you consult, then the two are joined and you leave. From the API, `calls.consult`
then `calls.transfer` with `toCallId`. See `call-control`.

**BLF** (Busy Lamp Field) — a SIP `SUBSCRIBE`/`NOTIFY` indicator a device shows for an extension
or parking slot's live state (`parking`).

**MWI** (Message Waiting Indicator) — the SIP mechanism that tells a device it has new voicemail.
See `call-data`.

**Presence** — a user's status, `available`, `busy`, `offline` or `dnd`, from their devices'
registrations and calls; every change is kept in the presence log (`presenceLog`). See
`call-data`.

**Webhook** — an endpoint the stack POSTs each realtime event to, with an `X-Zamfono-Signature`
HMAC of the body. See `webhooks`.

**Mail template** — the subject and bodies one kind of mail is rendered from, builtin or the
tenant's own (`mailTemplates`). See `mail-templates`.

**CLIR** — withholding the caller's own number on an outbound call.

**Recording (a participation)** — one stereo file capturing one user's side of one call, made
when that user's or the routing ring group's recording flag is set. See `recording-consent`.

**Snoop channel** — the ARI mechanism recording uses: a channel that mirrors another channel's
audio without joining the call.

**Audit entry** — one `audit_log` row: the actor, the channel it arrived on (`rest`, `mcp`, `ui`,
`undo`, `job`), the operation name, the entity and a field-level diff. Every configuration change
writes one.

**Undo** — reverting one audit entry's diff through `audit.undo` (`POST /api/v1/audit/{id}/undo`).
See `guardrails` and the `undo` recipe.

**Soft delete** — marking a config row `deletedAt` instead of removing it. The row and its id stay
reachable for undo until the retention job purges it.

**Channel** (audit) — how an operation was called: `rest`, `mcp`, `ui`, `undo` or `job`. Not to be
confused with a SIP or ARI channel, a live leg of a call.

**Routing trace / call log** — the structured JSON lines a call's diagnostics level appends to
`calls.log`: DID match, OOO evaluation, members rung, the fallback taken. See
`diagnose-bad-call`.
