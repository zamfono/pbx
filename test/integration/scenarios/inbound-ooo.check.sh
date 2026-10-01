#!/usr/bin/env bash
# §10.1 step 2: the tenant's OOO rule on the ring group applies its forward target and ends the
# pipeline before the group is ever offered a member to ring, so the call lands in the group's
# own mailbox (the rule's `mailboxRingGroup` target, `inbound-ooo.setup.sh`) and the phone the
# group would otherwise ring never sees an INVITE. §10.1 step 2's own trace event, `"ooo"`, is
# the only place the rule firing is visible after the call, so it is checked here too, not just
# where it landed.
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

group_id=$(ci_group)
bash "$here/_unavailable-check.sh" "$1" "$2" "$3" "$group_id" 20

newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

call = json.load(sys.stdin)
if not [e for e in trace(call) if e.get("event") == "ooo" and e.get("active") is True]:
    sys.exit("no out-of-office rule recorded as active in the call log: " + json.dumps(call)[:600])
'
