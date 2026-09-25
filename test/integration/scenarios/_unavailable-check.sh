#!/usr/bin/env bash
# The history check three scenarios share, wherever the pipeline sends a call to a group's
# mailbox without ever offering it to a member's phone: two ring-group scenarios (§10.1 step 5,
# "If no member is ringable, the `unavailable` rule fires immediately without ringing") and the
# OOO scenario (§10.1 step 2, whose forward target ends the pipeline before ringing is ever
# reached). The newest call reached group `$4`, ended in that group's mailbox rather than at the
# external number a ring group's `unanswered` rule would name, and within `$5` seconds of
# arriving, well inside the group's ring timeout; and the phone was never offered the call.
#
# Usage: _unavailable-check.sh <api-base> <token> <compose> <group-id> <max-seconds>
set -euo pipefail

api_base=$1
token=$2
compose=$3
group_id=$4
max_seconds=$5
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

invites=$(bash "$here/../phone.sh" "$compose" invites)
[ "$invites" = 0 ] || { echo "the phone was sent $invites INVITE(s)" >&2; exit 1; }

voicemails=$(api GET /voicemails)
newest_call | python3 -c '
import json, sys
from datetime import datetime

group, max_seconds, voicemails = sys.argv[1], float(sys.argv[2]), json.loads(sys.argv[3])
call = json.load(sys.stdin)

def at(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))

problems = []
if call["ringGroupId"] != group:
    problems.append("the call did not reach the group")
status = call["status"]
if status != "voicemail":
    problems.append(f"the call ended {status}, not in the group mailbox")
if call["answeredByUserId"]:
    problems.append("a member answered the call")
if not call["endedAt"]:
    problems.append("the call was never closed")
elif (at(call["endedAt"]) - at(call["startedAt"])).total_seconds() > max_seconds:
    problems.append(f"the call took longer than {max_seconds:.0f} s, as if the group had rung")
if not any(v["mailboxRingGroupId"] == group for v in voicemails["items"]):
    problems.append("the group mailbox holds no message")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$group_id" "$max_seconds" "$voicemails"
