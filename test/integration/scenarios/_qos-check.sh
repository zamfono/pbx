#!/usr/bin/env bash
# §7 level `qos`, §11 `call_qos`: the newest call in the history, answered and bridged, has one
# row per leg, the caller's and the callee's, however the call ended. The core reads no channel's
# statistics while a call runs; each row is what Asterisk set on its leg as it hung up, pushed
# with the leg's ChannelDestroyed, so the trunk side hanging up first still has its row.
# What sipp's media makes measurable here varies (it sends no RTCP, and the harness's RTP need
# not reach Asterisk's media ports at all), so each figure is only held to be a number or null,
# and a round trip never the 0 an unmeasured one used to read as. The rows are printed, for the
# run's log.
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
    for field in ("jitterMs", "lossPct", "rttMs"):
        value = row[field]
        if value is not None and not isinstance(value, (int, float)):
            sys.exit("call_qos row %s has a %s that is no number" % (row, field))
    if row["rttMs"] is not None and not row["rttMs"] > 0:
        sys.exit("call_qos row %s has a round trip neither measured nor null" % row)
print("call_qos of call %s: %s" % (call["id"], rows))
'
