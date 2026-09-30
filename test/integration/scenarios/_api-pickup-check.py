"""The history check the `inbound-api-pickup*` scenarios share (§10.1 "Pickup" over the API, §7).

Reads the picked-up call (`GET /calls/{id}`) on stdin and asserts its row and its trace: the
pickup is recorded with its actor, and the ring it started on the picker's own phone is written
into this call's trace, each line a `pickupRing` whose `step` names what happened, so a pickup
that failed is explained where it was asked for.

Usage: _api-pickup-check.py <picker-id> <outcome>

`outcome` is `answered` (the picker's phone answered and took the call: the row names the picker
as its answerer) or `unanswered` (it rang out: the call went on to the group's mailbox, and the
trace says the pickup went unanswered).
"""

import json
import sys

picker, outcome = sys.argv[1:3]
call = json.load(sys.stdin)
lines = [json.loads(line) for line in (call.get("log") or "").splitlines()]


def having(event, **fields):
    """The trace lines of `event` carrying every one of `fields`."""
    return [
        line
        for line in lines
        if line.get("event") == event and all(line.get(k) == v for k, v in fields.items())
    ]


problems = []
if not call["ringGroupId"]:
    problems.append("the call did not reach the group")
if not call["endedAt"]:
    problems.append("the call was never closed")
if not [line for line in having("pickup", userId=picker, ext="101") if line.get("actorUserId")]:
    problems.append("no pickup line names the picker, the rung extension and the actor")
if not [line for line in having("pickupRing", step="rungDevice", userId=picker) if line.get("channelId")]:
    problems.append("the pickup's ring on the picker's phone is not in the trace")
if having("rungDevice", userId=picker):
    problems.append("the pickup's ring reads as the call's own")

if outcome == "answered":
    if call["status"] != "answered":
        problems.append("the picked-up call ended %s, not answered" % call["status"])
    if call["answeredByUserId"] != picker:
        problems.append("the picked-up call does not name the picker as its answerer")
else:
    if call["status"] != "voicemail":
        problems.append("the call ended %s, not in the group mailbox" % call["status"])
    if call["answeredByUserId"] == picker:
        problems.append("the call names the picker as its answerer")
    if not having("pickup", userId=picker, result="unanswered"):
        problems.append("the trace does not say the pickup went unanswered")

if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:2000])
