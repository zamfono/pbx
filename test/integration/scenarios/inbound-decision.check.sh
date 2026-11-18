#!/usr/bin/env bash
# §10.1 step 7 "Decisions": the decision took its case for the caller and sent the call to the
# group's mailbox without the phone being offered it; the routing trace names the decision and the
# case taken (its first, 0) before the mailbox's own lines. Unlike `inbound-ooo`, whose rule fires
# inside the group, the call never reaches the group itself, so it carries no group context
# (`ringGroupId` null): `_unavailable-check.sh`, which expects one, does not fit.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

invites=$(bash "$here/../phone.sh" "$compose" invites)
[ "$invites" = 0 ] || { echo "the phone was sent $invites INVITE(s)" >&2; exit 1; }

group_id=$(ci_group)
voicemails=$(api GET /voicemails)
read -r _ decision_id < "$(state_file decision)"
newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from datetime import datetime
from _call_trace import trace

group, decision_id, voicemails = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
call = json.load(sys.stdin)

def at(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))

problems = []
if call["ringGroupId"] is not None:
    problems.append("the call was offered to a group")
status = call["status"]
if status != "voicemail":
    problems.append(f"the call ended {status}, not in the group mailbox")
if call["answeredByUserId"]:
    problems.append("a member answered the call")
if not call["endedAt"]:
    problems.append("the call was never closed")
elif (at(call["endedAt"]) - at(call["startedAt"])).total_seconds() > 25:
    problems.append("the call took longer than 25 s, as if the group had rung")
if not any(v["mailboxRingGroupId"] == group for v in voicemails["items"]):
    problems.append("the group mailbox holds no message")
events = [e.get("event") for e in trace(call)]
taken = [e for e in trace(call) if e.get("event") == "decision"]
if [(e.get("decisionId"), e.get("decisionCase")) for e in taken] != [(decision_id, 0)]:
    problems.append("the decision did not take its first case once")
elif "voicemail" in events and events.index("decision") > events.index("voicemail"):
    problems.append("the decision was traced after the mailbox")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$group_id" "$decision_id" "$voicemails"
