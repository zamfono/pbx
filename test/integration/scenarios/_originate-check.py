"""The history check the click-to-dial scenarios share (§10.2 "Click-to-dial", §7 `events`).

Reads the originated call (`GET /calls/{id}`) on stdin and asserts its row and its trace: a call
from the user's own extension to the target, whose trace names the acting user, each device of
the user it rang, and then what came of the ring.

Usage: _originate-check.py <user-id> <target> <outcome> [<answerer>]

`outcome` is `answered` (a device answered and the target answered in turn: `answerer` is `trunk`
for an external number, or the user id of the colleague whose phone answered), `unanswered` (the
device rang out) or `declined` (the device refused at once). Either of the last two is a `failed`
row whose trace says the ring went unanswered.
"""

import json
import sys

from _call_trace import trace

user_id, target, outcome = sys.argv[1:4]
answerer = sys.argv[4] if len(sys.argv) > 4 else ""
call = json.load(sys.stdin)
lines = trace(call)


def having(event, **fields):
    """The trace lines of `event` carrying every one of `fields`."""
    return [
        line
        for line in lines
        if line.get("event") == event and all(line.get(k) == v for k, v in fields.items())
    ]


problems = []
if call["fromUri"] != "101" or call["toUri"] != target:
    problems.append("the call is not from 101 to %s" % target)
if call["callerUserId"] != user_id:
    problems.append("the call does not name 101 as its caller")
if not call["endedAt"]:
    problems.append("the call was never closed")
actors = [line for line in having("originate", target=target) if line.get("actorUserId")]
if not actors:
    problems.append("no originate line names the acting user")
rung = [line for line in having("rungDevice", userId=user_id) if line.get("channelId")]
if not rung:
    problems.append("no rungDevice line for 101's phone")

if outcome == "answered":
    if call["status"] != "answered":
        problems.append("the call ended %s, not answered" % call["status"])
    answered_device = having("deviceAnswered")
    if not answered_device or answered_device[0]["channelId"] != rung[0]["channelId"]:
        problems.append("no deviceAnswered line for the phone that rang")
    if answerer == "trunk":
        if not having("answered", leg="trunk"):
            problems.append("no answered line for the trunk leg")
    elif not having("answered", leg="device", userId=answerer):
        problems.append("no answered line for the colleague's phone")
    elif call["answeredByUserId"] != answerer:
        problems.append("the call does not name the colleague as its answerer")
else:
    if call["status"] != "failed":
        problems.append("the call ended %s, not failed" % call["status"])
    if not having("originate", result="unanswered"):
        problems.append("the trace does not say the ring went unanswered")
    if having("deviceAnswered"):
        problems.append("the trace has a phone answer that never happened")
    if outcome == "declined" and not having("declined", channelId=rung and rung[0]["channelId"]):
        problems.append("the trace does not say the phone declined")

if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:1500])
