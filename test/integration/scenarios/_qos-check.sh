#!/usr/bin/env bash
# §7 level `qos`, §11 `call_qos`: the newest call in the history, answered and bridged, has one
# row per leg, the caller's and the callee's, however the call ended; the trunk side hanging up
# first takes its statistics with its channel, so its row is the one read while the call ran.
# What sipp's media makes measurable here varies (it sends no RTCP, and the harness's RTP need
# not reach Asterisk's media ports at all), so each figure is only held to be a number or null,
# and a round trip never the 0 an unmeasured one used to read as.
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
'
