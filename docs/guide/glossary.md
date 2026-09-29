# Glossary

**Extension** — the short internal number dialled between colleagues. A user, a ring group and a
parking slot each own one extension.

**DID** — a phone number the tenant owns, routed on arrival to a forward target.

**Forward target** — the seven-kind vocabulary (`user`, `ringGroup`, `external`, `mailboxUser`,
`mailboxRingGroup`, `announcement`, `menu`) every routing rule points at. See `mental-model`.

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

**BLF** (Busy Lamp Field) — a SIP `SUBSCRIBE`/`NOTIFY` indicator a device shows for an extension
or parking slot's live state.

**MWI** (Message Waiting Indicator) — the SIP mechanism that tells a device it has new voicemail.

**CLIR** — withholding the caller's own number on an outbound call.

**Recording (a participation)** — one stereo file capturing one user's side of one call, made
when that user's or the routing ring group's recording flag is set. See `recording-consent`.

**Snoop channel** — the ARI mechanism recording uses: a channel that mirrors another channel's
audio without joining the call.

**Audit entry** — one `audit_log` row: the actor, the channel it arrived on (`rest`, `mcp`, `ui`,
`undo`, `job`), the operation name, the entity and a field-level diff. Every configuration change
writes one.

**Undo** — reverting one audit entry's diff through `audit.undo` (`POST /audit/{id}/undo`). See
`guardrails` and the `undo` recipe.

**Soft delete** — marking a config row `deletedAt` instead of removing it. The row and its id stay
reachable for undo until the retention job purges it.

**Channel** (audit) — how an operation was called: `rest`, `mcp`, `ui`, `undo` or `job`. Not to be
confused with a SIP or ARI channel, a live leg of a call.

**Routing trace / call log** — the structured JSON lines a call's diagnostics level appends to
`calls.log`: DID match, OOO evaluation, members rung, the fallback taken. See
`diagnose-bad-call`.
