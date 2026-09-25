#!/usr/bin/env bash
# The history check the two menu-hangup scenarios share (§10.1 step 6): the caller hung up during
# the greeting, and nothing went on after they left — no replay, no fallback ringing the phone —
# so the phone was never offered a call, and the newest call, the one to DID `$4`, is closed as
# missed, answered by nobody, within `$5` seconds of arriving, when its caller left.
#
# Usage: _menu-check.sh <api-base> <token> <compose> <did> <max-seconds>
set -euo pipefail

api_base=$1
token=$2
compose=$3
did=$4
max_seconds=$5
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

invites=$(bash "$here/../phone.sh" "$compose" invites)
[ "$invites" = 0 ] || { echo "the phone was sent $invites INVITE(s)" >&2; exit 1; }

newest_call | python3 -c '
import json, sys
from datetime import datetime

did, max_seconds = sys.argv[1], float(sys.argv[2])
call = json.load(sys.stdin)

def at(stamp):
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))

problems = []
if call["toUri"] != did:
    problems.append("the newest call is not the one to the menu")
status = call["status"]
if status != "missed":
    problems.append(f"the call ended {status}, not missed")
if call["answeredByUserId"] or call["ringGroupId"]:
    problems.append("the call went on to a user or a group after its caller left")
if not call["endedAt"]:
    problems.append("the call was never closed")
elif (at(call["endedAt"]) - at(call["startedAt"])).total_seconds() > max_seconds:
    problems.append(f"the call was closed later than {max_seconds:.0f} s, after its caller left")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$did" "$max_seconds"
