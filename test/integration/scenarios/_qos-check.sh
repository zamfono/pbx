#!/usr/bin/env bash
# §7 level `qos`, §11 `call_qos`: the newest call in the history, answered and bridged, has one
# row per leg, the caller's and the callee's, however the call ended. The core reads no channel's
# statistics while a call runs; each row is what Asterisk set on its leg as it hung up, pushed
# with the leg's ChannelDestroyed, so the trunk side hanging up first still has its row.
# sipp sends no RTCP, so a round trip is never measured here: it is held to be null or a real
# one, never the 0 an unmeasured one used to read as. Jitter and loss are measured on a leg that
# received RTP; with `measured`, the scenario's sides both played audio (sipp's pcap), so every
# leg's jitter and loss must be numbers, and every leg must have received and sent packets
# (`rxPackets`, `txPackets` above 0: a leg whose peer's audio never arrived reads 0 received);
# else each is only held to be a number or null, a count a whole number. The rows are printed,
# for the run's log.
#
# Usage: _qos-check.sh <api-base> <token> [measured]
set -euo pipefail

api_base=$1
token=$2
measured=${3:-}
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

call_id=$(api GET /calls | jsonfield items.0.id)
api GET "/calls/$call_id" | python3 -c '
import json, sys
measured = sys.argv[1] == "measured"
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
    for field in ("rxPackets", "txPackets"):
        value = row[field]
        if value is not None and (not isinstance(value, int) or isinstance(value, bool)
                                  or value < 0):
            sys.exit("call_qos row %s has a %s that is no packet count" % (row, field))
        if measured and not (isinstance(value, int) and value > 0):
            sys.exit("call_qos row %s counts no packet in %s on a leg that carried audio"
                     % (row, field))
    if row["rttMs"] is not None and not row["rttMs"] > 0:
        sys.exit("call_qos row %s has a round trip neither measured nor null" % row)
    if measured and (row["jitterMs"] is None or row["lossPct"] is None):
        sys.exit("call_qos row %s measured no jitter or loss on a leg that carried audio" % row)
print("call_qos of call %s: %s" % (call["id"], rows))
' "$measured"
