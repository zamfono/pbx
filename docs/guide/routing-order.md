# Routing order

Every call — inbound from a trunk, internal between colleagues, or re-entering through a forward
— runs through the same pipeline once it targets a user, a ring group or a menu.

## Inbound and internal pipeline

1. **Entry.** A caller on the blocklist, which `blockedNumbers.create` (`POST /blockedNumbers`)
   fills, is rejected outright. An inbound call resolves its DID to a forward target, or falls to
   the fallback of the number block it lies in or the tenant fallback when no `dids` row matches,
   most precise match first (`numbers`). An internal call targets the
   dialled extension directly. A withheld caller number is checked against the target's
   `rejectAnonymous` setting (self-service per user, tenant-wide default otherwise) before anything
   else runs.
2. **Out of office.** The target's in-effect `ooo` rule wins, tenant-wide otherwise. This step
   runs for internal calls too — an absent colleague's mailbox catches calls from other
   colleagues just as it catches outside calls.
3. **Opening hours.** Inbound and forwarded calls only. Outside every open interval of the
   target's `hours` schedule, tenant-wide otherwise, the schedule's closed target applies.
4. **Target user.** In order: an `unconditional` forward rule; DND; no registered device and no
   find-me entry (`offline`); otherwise every registered device rings in parallel, alongside any
   find-me legs. The first accepted answer wins. `busy` applies when every device is busy;
   `noAnswer` applies when nobody answers within `ringTimeoutS`. An absent rule falls back to the
   user's own mailbox, or a rejection when none is enabled.
5. **Target ring group.** Members (nested user groups flattened) are filtered to who is
   ringable — not DND, not offline, not under an OOO rule, and, unless `skipBusy` is cleared, not
   already in a call. The configured strategy (`simultaneous`, `sequential`, `random`) then rings
   the ringable members; the group's `unanswered` rule is the fallback, `unavailable` fires at
   once when nobody is ringable.
6. **Target menu.** The greeting plays and DTMF is collected against the menu's target map;
   `allowExtensionDialing` also accepts a live user or ring-group extension. Silence or an
   unmatched string replays the greeting up to `maxAttempts`, after which the menu's fallback
   target applies.
7. **Forward targets.** A `user` or `ringGroup` target re-enters at **Entry** with the hop counter
   increased; a `menu` target re-enters without counting a hop. After the third hop the call goes
   to the last target's mailbox, or is released if it has none.

## Outbound resolution

The dialled string is resolved in order: a feature code, then an emergency number (see
`emergency-calls`), then an internal extension or parking slot, then, once normalized to E.164, a
tenant DID (routed internally, never out through a trunk), then an external number dialled out
through the configured `outboundRoutes`.
