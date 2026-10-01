#!/usr/bin/env bash
# §10.1 step 5: with its only member on a call of their own, the `skip_busy` group skipped them,
# so its `unavailable` rule sent the call to its mailbox at once, without offering it to the
# member's phone as call waiting. The member's own outbound call is in the history as theirs, from
# their extension rather than the device's SIP username (§11.2 `calls.from_uri`, §9.3 caller ID).
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r group_id _ < "$(state_file skip-busy)"
bash "$(dirname "$0")/_unavailable-check.sh" "$1" "$2" "$3" "$group_id" 20

api GET /calls | python3 -c '
import json, sys
calls = json.load(sys.stdin)["items"]
own = next((c for c in calls if c["direction"] == "outbound" and c["toUri"] == "+15557777"), None)
if own is None:
    sys.exit("the member'"'"'s own outbound call is missing from the history")
if own["fromUri"] != "101":
    sys.exit("the member'"'"'s own call came from " + repr(own["fromUri"]) + ", not the extension 101")
'
