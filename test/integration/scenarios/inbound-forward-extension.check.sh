#!/usr/bin/env bash
# §10.1 step 7 "Templates": the DID's `extension` target rendered 101 from the number dialled and
# the call went to that extension's user as a call to them does: the CI phone answered, the user
# is the call's callee and answerer, and the trace holds no `templateInvalid` and no `fallback`
# line. A DID's own target is the call's first hop, so the user counted none on top.
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

user, did_id = sys.argv[1], sys.argv[2]
call = json.load(sys.stdin)
problems = []
if call["toUri"] != "+15552101" or call["didId"] != did_id:
    problems.append("the call is not the one to +15552101")
if call["status"] != "answered":
    problems.append("the call ended " + call["status"])
if call["calleeUserId"] != user or call["answeredByUserId"] != user:
    problems.append("extension 101 is not who the call was for and who answered it")
if call["ringGroupId"] is not None:
    problems.append("the call was offered to a group")
events = [e.get("event") for e in trace(call)]
for unexpected in ("templateInvalid", "fallback"):
    if unexpected in events:
        problems.append("the trace has a " + unexpected + " line")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$(user_with_ext 101)" "$(cat "$(state_file inbound-forward-extension)")"
