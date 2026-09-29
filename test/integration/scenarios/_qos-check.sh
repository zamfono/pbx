#!/usr/bin/env bash
# §7 level `qos`, §11 `call_qos`: the newest call in the history, answered and bridged between two
# parties who both sent media, has one row per leg, the caller's and the callee's, however the
# call ended. sipp sends RTP but no RTCP, so only what Asterisk measures itself is asserted: loss
# and jitter as numbers, and a round trip that is either unmeasured (null) or a positive number,
# never the 0 an unmeasured one used to read as.
#
# Usage: _qos-check.sh <api-base> <token>
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

call_id=$(api GET /calls | jsonfield items.0.id)
api GET "/calls/$call_id" | python3 -c '
import json, sys
call = json.load(sys.stdin)
rows = call["qos"]
roles = sorted(row["role"] for row in rows)
if roles != ["callee", "caller"]:
    sys.exit("call %s has call_qos rows for %s, not one caller and one callee: %s"
             % (call["id"], roles, rows))
for row in rows:
    for field in ("jitterMs", "lossPct"):
        if not isinstance(row[field], (int, float)):
            sys.exit("call_qos row %s has no %s" % (row, field))
    if row["rttMs"] is not None and not row["rttMs"] > 0:
        sys.exit("call_qos row %s has a round trip neither measured nor null" % row)
'
