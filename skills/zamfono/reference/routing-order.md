# Routing order

Every call — inbound from a trunk, internal between colleagues, or re-entering through a forward
— runs through the same pipeline once it targets a user, a ring group or a menu. A `decision`
target is first replaced by the target its conditions pick (`decisions`).

## Inbound and internal pipeline

1. **Entry.** A caller on the blocklist, which `blockedNumbers.create`
   (`POST /api/v1/blockedNumbers`) fills, is rejected outright. An inbound call resolves its DID to
   a forward target, or falls to the fallback of the number block it lies in or the tenant fallback
   when no `dids` row matches, most precise match first (`numbers`). An internal call targets the
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
5. **Target ring group.** Members (nested user groups flattened, `user-groups`) are filtered to
   who is ringable — not DND, not offline, not under an OOO rule, and, unless `skipBusy` is
   cleared, not already in a call. The configured strategy (`simultaneous`, `sequential`, `random`) then rings
   the ringable members; the group's `unanswered` rule is the fallback, `unavailable` fires at
   once when nobody is ringable.
6. **Target menu.** The greeting plays and DTMF is collected against the menu's target map;
   `allowExtensionDialing` also accepts a live user, ring-group, decision or menu extension.
   Silence or an unmatched string replays the greeting up to `maxAttempts`, after which the
   menu's fallback target applies.
7. **Forward targets.** A `user` or `ringGroup` target re-enters at **Entry** with the hop counter
   increased; a `menu` target re-enters without counting a hop. Past the hop limit,
   `settings.maxForwardHops` (3 unless set), the call goes to the last target's mailbox, or is
   released if it has none. An `external`, `sip`, `webSocket` or `extension` target that does not
   work — busy, refused, no route or trunk, a bot that cannot be reached, its `ringTimeoutS` run
   out, or a template that renders nothing usable (`templates`) — hands the call to its
   `fallback`, as if the rule had named that target instead; a ring-group member's
   forward and a `*5` party never fall back (see `mental-model`). A `decision` target is resolved
   first, and the target it picks is applied as if the rule had named it: the hop limit, its
   announcement and its hop as for that kind. A call meeting the same decision twice with nothing
   in between — no hop, no forward rule, no menu key — ends as at the hop limit (`decisions`). An
   `httpRequest` target sends its request while the caller hears ringing, then applies its
   target, or its error target when the request failed, counting no hop itself and bounded like a
   decision (`http-requests`).

## Outbound resolution

The dialled string is resolved in order: a feature code, then an emergency number (see
`emergency-calls`), then an internal extension or parking slot (`parking`), a decision's or
menu's extension entering it as a menu option would, then, once normalized to E.164, a tenant
DID (routed internally, never out through a trunk), then an external number dialled out through
the configured `outboundRoutes`.
