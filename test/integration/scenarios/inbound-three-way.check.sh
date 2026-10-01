#!/usr/bin/env bash
# §10.2 "Three-way calls": the added leg is its own `calls` row with `parent_call_id` set to the
# running call, answered by the party it dialled. The initiator hanging up ended the bridge for
# everyone, so the running call is closed as well.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

api GET /calls | python3 -c '
import json, sys
calls = json.load(sys.stdin)["items"]
# Newest first: the most recent child is the one this scenario made.
added = next((c for c in calls if c["parentCallId"]), None)
if added is None:
    sys.exit("no call carries a parent_call_id")
running = next((c for c in calls if c["id"] == added["parentCallId"]), None)
problems = []
if running is None:
    problems.append("the running call is missing from the history")
else:
    if running["status"] != "answered" or not running["ringGroupId"]:
        problems.append("the running call was not recorded as the answered group call")
    if not running["endedAt"]:
        problems.append("the running call was never closed")
    if added["callerUserId"] != running["answeredByUserId"]:
        problems.append("the added leg does not name the initiator as its caller")
if added["status"] != "answered":
    problems.append("the added leg was not recorded as answered")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps({"running": running, "added": added}))
'
