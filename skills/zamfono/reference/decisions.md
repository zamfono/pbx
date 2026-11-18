# Decisions

A **decision** sends a call to one of several targets: an ordered list of cases, each a list of
conditions and a target, and a default target. The first case whose conditions all match is
taken, else the default — a switch statement for calls. Any forward target can point at one,
`{ "kind": "decision", "decisionId": "…" }`, so a DID, a menu option, a forward rule, an
out-of-office rule or a closed schedule can each branch by time, caller or a colleague's status.

Only an admin sets a decision target, since its cases may hold `sip` or `webSocket` targets. A
user reading their own forwarding, out-of-office rules or hours sees one as
`{ "managed": true, "kind": "decision" }`, and keeps it by sending that marker back
(`guardrails`).

## Create one

`decisions.create` (`POST /api/v1/decisions`):

```json
{
  "name": "Main line",
  "cases": [
    {
      "when": [{ "type": "callerUser" }],
      "target": { "kind": "ringGroup", "ringGroupId": "…support" }
    },
    {
      "when": [
        {
          "type": "any",
          "conditions": [
            { "type": "caller", "number": "+436991234567" },
            { "type": "callerUser", "userId": "…boss" }
          ]
        }
      ],
      "target": { "kind": "user", "userId": "…assistant" }
    }
  ],
  "default": { "kind": "menu", "menuId": "…" }
}
```

Then point a number at it: `dids.update` (`PATCH /api/v1/dids/{id}`) with
`{ "target": { "kind": "decision", "decisionId": "…" } }`. `decisions.update`
(`PATCH /api/v1/decisions/{id}`) replaces the cases as a whole; `decisions.list`
(`GET /api/v1/decisions`) and `decisions.get` (`GET /api/v1/decisions/{id}`) read them back.

## Conditions

All conditions of a case must match. Each is instant and reads only the time, the caller and the
status of the users it names.

| `type`       | Fields               | Matches                                                                                                |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `schedule`   | `intervals`          | during a weekly interval, `{ "weekday": 1, "opens": "08:00", "closes": "17:00" }`                      |
| `dates`      | `ranges`             | on a day of `{ "from", "to" }`, both inclusive: `2026-12-24`/`2027-01-06` once, `12-24`/`01-06` yearly |
| `caller`     | `number`, `isPrefix` | an outside caller with that number, or one starting with it; `number: null` a withheld one             |
| `callerUser` | `userId`             | a colleague's phone placed the call, that colleague alone with `userId`                                |
| `presence`   | `userId`, `status`   | while the user's status is one of `status`                                                             |
| `any`, `all` | `conditions`         | one of them, or all of them                                                                            |
| `not`        | `condition`          | when it does not                                                                                       |

Times and dates are the tenant's (`settings.timezone`), evaluated when the call reaches the
decision. `02-29` matches in leap years only. Operators nest at most 32 levels.

A `presence` condition reads, in order: `away` while the user's own out-of-office rule is in
effect, `closed` outside the user's own opening hours, else the presence colleagues see — `busy`
(in a call or ringing), `dnd`, `offline` (no phone registered) or `available`. The tenant's own
OOO and hours do not count. Note that `offline` ignores find-me numbers: a decision "Anna offline
→ colleague" sends a call away that Anna's mobile would have taken.

## Who the caller is

The caller is whoever is on the calling line, not the call's direction:

- An outside caller is matched by `caller`; a colleague's phone by `callerUser`, also when they
  dial one of the company's own numbers. The same person calling from their mobile is an outside
  number.
- A customer whom Anna **blind**-transfers to a decision is still the caller, matched by
  `caller`. Anna adding someone with `*5`, or **consulting** before an attended transfer, dials as
  herself, matched by `callerUser`. So a decision "VIP number → account manager" answers
  differently for a blind and an attended transfer of the same VIP; use a blind transfer where it
  matters.
- Every condition applies to internal calls too — unlike opening hours, which only inbound calls
  meet. Add `{ "type": "not", "condition": { "type": "callerUser" } }` to a case that is meant
  for outside callers alone.

## Decisions, opening hours and out-of-office

Opening hours and out-of-office rules describe when a person or group is reachable; a decision
describes where a number goes. Both apply: OOO and opening hours of the target a decision picks
still run, the tenant's included, and can override it. A decision "open until 20:00 → Support"
sends an 18:00 call to Support, whose hours are the tenant's if it has none of its own — and when
the tenant closes at 17:00, the call reaches the tenant's closed target. Give Support its own
schedule with `hours.set` (`PUT /api/v1/ringGroups/{id}/hours`) when the decision should have the
last word.

## Test it

`decisions.dryRun` (`POST /api/v1/decisions/{id}/dryRun`) shows which case a call would take,
without placing one:

```json
{
  "at": "2026-12-24T18:30",
  "caller": { "number": "+436991234567" },
  "presence": { "…anna": "busy" }
}
```

It answers every decision evaluated, each condition's result with the input it read (the time, the
caller, the status), the target the call goes to, and the out-of-office rule or opening hours that
would then override it. `caller` takes `{ "userId": "…" }` for a colleague; `direction` `internal`
skips opening hours, as an internal call does.

## Loops

A call that meets the same decision twice without anything happening in between ends as at the
forwarding limit: in the last target's mailbox, else released. A ring of a user or group through
a forward, a forward rule, an OOO rule, a closed schedule or a key pressed in a menu counts as
something happening, so a menu option leading back to the decision works as often as the caller
presses it. The call trace names each decision and the case it took (`diagnose-bad-call`).

## An extension of its own

A decision, like a menu, can have an extension: `extension` on `decisions.create`, or
`decisions.update` to give, move or remove one. It can then be dialled, transferred to, put on a
BLF key and found in search; its lamp never lights, as nothing rings there. With `*5` or a
consultation it is taken by where it sends the call, a colleague or an outside number; one that
ends in a menu, a mailbox or a voice bot is refused there, as those are no party to talk to.

## Deleting

`decisions.delete` (`DELETE /api/v1/decisions/{id}`) is refused while a number, rule, menu or
another decision points at it, and frees its extension. A user named in a live decision's
`presence` or `callerUser` condition cannot be deleted until the decision no longer names them.
