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

newest_call | python3 -c '
import json, sys

call = json.load(sys.stdin)
active = False
for line in (call.get("log") or "").splitlines():
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if isinstance(entry, dict) and entry.get("event") == "ooo" and entry.get("active") is True:
        active = True
if not active:
    sys.exit("no out-of-office rule recorded as active in the call log: " + json.dumps(call)[:600])
'
