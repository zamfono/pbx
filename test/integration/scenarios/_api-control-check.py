"""The history checks of the `inbound-api-*` scenarios (§10.3 "Live calls", §7).

Reads the calls the scenario made, each `GET /calls/{id}` with its trace, from the JSON files
given, and asserts what the call control over the API leaves behind, by mode:

  consult    <member-id> <colleague-id> <original.json> <consultation.json>
             the original call closed answered by the member, its trace naming the attended
             transfer to the consultation; the consultation carried the conversation on as the
             original's child, still naming the member as its caller, answered by the colleague.
  add-party  <member-id> <colleague-id> <running.json> <added.json>
             the added leg is the running call's child, placed by the member and answered by the
             colleague; the running call closed answered by the member.
  hold       <member-id> <call.json>
             the call stayed the member's answered call, its trace naming the hold and the
             resume, each with its actor (the harness's own owner).
  decline    <owner-id> <member-id> <call.json> <ring-timeout-s>
             the owner's decline is in the trace, their leg ended with Q.850 21 (SIP 603), and the
             member answered well before the owner's own ring would have timed out.

Usage: _api-control-check.py <mode> <argument>...
"""

import json
import sys
from datetime import datetime

mode, *args = sys.argv[1:]
problems = []


def load(path):
    with open(path, encoding="utf-8") as handle:
        call = json.load(handle)
    call["lines"] = [json.loads(line) for line in (call.get("log") or "").splitlines()]
    return call


def having(call, event, **fields):
    """The trace lines of `event` carrying every one of `fields`."""
    return [
        line
        for line in call["lines"]
        if line.get("event") == event and all(line.get(k) == v for k, v in fields.items())
    ]


def expect(condition, problem):
    if not condition:
        problems.append(problem)


def closed_answered(call, answerer, name):
    expect(call["status"] == "answered", "the %s ended %s, not answered" % (name, call["status"]))
    expect(call["endedAt"], "the %s was never closed" % name)
    expect(
        call["answeredByUserId"] == answerer,
        "the %s was not answered by %s but %s" % (name, answerer, call["answeredByUserId"]),
    )


def seconds(start, end):
    def parse(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    return (parse(end) - parse(start)).total_seconds()


if mode == "consult":
    member, colleague, original_file, consultation_file = args
    original, consultation = load(original_file), load(consultation_file)
    closed_answered(original, member, "transferred call")
    expect(
        having(original, "attendedTransfer", toCallId=consultation["id"]),
        "the transferred call's trace names no attended transfer to the consultation",
    )
    expect(having(original, "consult", target="102"), "the trace names no consultation of 102")
    closed_answered(consultation, colleague, "consultation")
    expect(
        consultation["parentCallId"] == original["id"],
        "the consultation is not the transferred call's child",
    )
    expect(
        consultation["callerUserId"] == member,
        "the consultation does not name the member who placed it as its caller",
    )
    expect(
        having(consultation, "attendedTransfer", parentCallId=original["id"]),
        "the consultation's trace names no attended transfer",
    )
    calls = {"original": original, "consultation": consultation}
elif mode == "add-party":
    member, colleague, running_file, added_file = args
    running, added = load(running_file), load(added_file)
    closed_answered(running, member, "running call")
    closed_answered(added, colleague, "added leg")
    expect(added["parentCallId"] == running["id"], "the added leg is not the running call's child")
    expect(added["callerUserId"] == member, "the added leg does not name the member as its caller")
    expect(having(running, "addParty", target="102"), "the running call names no added party")
    calls = {"running": running, "added": added}
elif mode == "hold":
    member, call_file = args
    call = load(call_file)
    closed_answered(call, member, "held call")
    for event in ("hold", "resume"):
        expect(
            [line for line in having(call, event) if line.get("actorUserId")],
            "no %s naming its actor in the trace" % event,
        )
    calls = {"call": call}
elif mode == "decline":
    owner, member, call_file, ring_timeout_s = args
    call = load(call_file)
    closed_answered(call, member, "declined call")
    expect(having(call, "decline", actorUserId=owner), "the owner's decline is not in the trace")
    expect(having(call, "declined", cause=21), "no leg ended declined (Q.850 21)")
    expect(
        call["answeredAt"] and seconds(call["startedAt"], call["answeredAt"]) < float(ring_timeout_s),
        "the group did not move on at the decline: answered after %s s"
        % (call["answeredAt"] and seconds(call["startedAt"], call["answeredAt"])),
    )
    calls = {"call": call}
else:
    sys.exit("unknown mode %s" % mode)

if problems:
    for call in calls.values():
        call.pop("lines", None)
    sys.exit("; ".join(problems) + ": " + json.dumps(calls)[:3000])
