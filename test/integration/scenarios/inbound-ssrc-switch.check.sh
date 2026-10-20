#!/usr/bin/env bash
# TASK-68: Asterisk kept forwarding the trunk's audio to the device after the trunk switched RTP
# source with a backward sequence step (`inbound-ssrc-switch.xml`). The device's leg, the callee
# at level `qos`, sent the device about as many packets as the trunk played, 100 before the switch
# and 200 after: at least 250. An Asterisk that drops the new stream stops at about 100.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

MIN_SENT=250

call_id=$(api GET /calls | jsonfield items.0.id)
api GET "/calls/$call_id" | python3 -c '
import json, sys
minimum = int(sys.argv[1])
call = json.load(sys.stdin)
rows = {row["role"]: row for row in call["qos"]}
print("call %s qos: %s" % (call["id"], call["qos"]))
callee = rows.get("callee")
if callee is None:
    sys.exit("call %s has no call_qos row for the device: %s" % (call["id"], call["qos"]))
sent = callee["txPackets"] or 0
if sent < minimum:
    sys.exit("Asterisk sent the device %d packets, fewer than %d: the trunk'"'"'s audio after its "
             "SSRC switch never reached it" % (sent, minimum))
' "$MIN_SENT"
