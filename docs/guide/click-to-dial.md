# Click-to-dial

Placing a call from outside the phone: a CRM's call button, or the MCP assistant asked to "call
John". The stack rings the user's own phones first, and the one that answers dials the target
exactly as if the user had dialled it there.

## Placing the call

`calls.originate` (`POST /calls`) with `{ "target": "+43 1 2345678" }` rings every registered
phone of the caller, for their own `ringTimeoutS`. Once one answers, the stack dials `target` from
it: an extension rings that colleague or ring group, an external number leaves through the
outbound routes with the user's caller ID, CLIR and the trunk's channel cap, and an emergency
number goes out as one (`emergency-calls`). The result is `{ "callId": "…" }` at once, while the
phones still ring; the call shows in `calls.list` with `live: true` and, once it ended, in the
history with the actor in its trace (`diagnose-bad-call`).

- `userId` places the call on another user's phones; an admin only. A `user` places calls for
  themselves.
- A user with no registered phone is refused with 409, `detail` `noRegisteredDevice`, and the
  attempt is in the history all the same.
- A phone that does not answer, or declines, ends the call unanswered; nothing is dialled.

## What the target can be

Anything a phone dials, so a feature code works as it would there:

- a **parking slot** retrieves the call parked there: the user's answering phone takes it, as
  dialling the slot does (`parking`), and an empty slot plays the error tone;
- `#31#` or `*31#` before a number withholds or presents the number on that one call, as
  `clir` does below.

## Withholding the number on one call

`clir` sets this call's own CLIR: `true` withholds the number, `false` presents it, over the
user's `clir` (`users.update`), the trunk's and the tenant's default, exactly as `#31#` and
`*31#` before the target do. Left out, the defaults apply. An emergency call always presents the
number, whatever `clir` says, and a route whose trunk cannot carry a withheld number is skipped
as it is for a call from the phone.
