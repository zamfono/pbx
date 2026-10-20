#!/usr/bin/env bash
# §10.3 "Live calls", §10.1 "Transfers and pickup": the live call listed its two legs, neither a
# user's, the caller's on the trunk it arrived on and the SIP target's on the trunk it left by,
# with its target; the admin's transfer naming the caller's leg was accepted. The call closed
# answered with the transfer in its trace, and its log holds the BYE that released the SIP
# target's side and the target's 200 to it (§7 level `sip`). The caller's onward call, linked to
# it through `parent_call_id`, was answered by 101. The transferred caller's media timeline (§7
# level `qos`, which `sip` adds to) runs through both: the call it left sampled it as it closed,
# and the onward call as it started and while it ran, in 101's bridge at least once.
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

read -r call_id leg_id <<<"$(bash "$here/_api-control-check.sh" 1)"
parent=$(await_ended_call "$call_id" 15)
# At level `sip` the onward call, like every call, reaches the history a few seconds after it ends.
poll 15 1 onward_ended "$call_id" || { echo "the onward call of $call_id never ended" >&2; exit 1; }
calls=$(api GET /calls)
child_id=$(python3 -c '
import json, sys
print(next(c["id"] for c in json.loads(sys.argv[1])["items"] if c["parentCallId"] == sys.argv[2]))
' "$calls" "$call_id")
PYTHONPATH="$here" python3 - "$parent" "$calls" \
  "$(cat "$(state_file api-control.legs)")" "$(api GET "/calls/$child_id")" "$leg_id" \
  "$(user_with_ext 101)" "$(trunk_named ci-trunk)" <<'PY'
import json, re, sys
from _call_trace import trace

parent, calls, legs, onward = (json.loads(arg) for arg in sys.argv[1:5])
leg_id, member, trunk = sys.argv[5:8]

problems = []
roles = [(leg["role"], leg.get("trunkId"), "userId" in leg, bool(leg.get("target")))
         for leg in legs]
if roles != [("caller", trunk, False, False), ("callee", trunk, False, True)]:
    problems.append("the live call's legs are not the caller's and the SIP target's: %s" % legs)
if legs and legs[0]["id"] != leg_id:
    problems.append("the transfer named %s, not the caller's leg" % leg_id)
if parent["status"] != "answered":
    problems.append("the transferred call ended %s, not answered" % parent["status"])
if not [l for l in trace(parent) if l.get("event") == "transfer" and l.get("target") == "101"
        and l.get("actorUserId")]:
    problems.append("the call's trace has no transfer to 101 naming the acting user")
sip = [(l.get("direction"), l["raw"]) for l in trace(parent) if isinstance(l.get("raw"), str)]
if not [raw for d, raw in sip if d == "out" and raw.startswith("BYE ")]:
    problems.append("the call's log has no BYE releasing the SIP target's side")
if not [raw for d, raw in sip if d == "in" and raw.startswith("SIP/2.0 200 ")
        and re.search(r"(?im)^CSeq:\s*\d+ BYE", raw)]:
    problems.append("the call's log has no 200 answering that BYE")
child = next((c for c in calls["items"] if c["parentCallId"] == parent["id"]), None)
if child is None:
    problems.append("no onward call carries the transferred call as its parent")
elif child["status"] != "answered" or child["answeredByUserId"] != member:
    problems.append("the onward call ended %s, answered by %s, not by 101"
                    % (child["status"], child["answeredByUserId"]))
transferee = next((l.get("transferee") for l in trace(parent) if l.get("event") == "transfer"),
                  None)
def timeline(call):
    return [l for l in trace(call) if l.get("event") == "media" and l.get("channelId") == transferee]
if not [l for l in timeline(parent) if l.get("on") == "close"]:
    problems.append("the call the caller left has no media sample of the caller as it closed")
caller_media = timeline(onward)
if not [l for l in caller_media if l.get("on") == "onward"]:
    problems.append("the onward call has no media sample of the caller as it started")
# sipp's caller sends plain RTP and holds nothing.
if not [l for l in caller_media if "on" not in l and l.get("bridgeId") and l.get("bridgeTechnology")
        and isinstance(l.get("sent"), int) and l.get("readFormat") and l.get("nativeFormat")
        and l.get("rtpDest") and l.get("localSsrc") and l.get("secure") is False
        and l.get("rtpHold") is False and l.get("onHold") is False]:
    problems.append("the onward call's timeline has no periodic sample of the caller in a bridge, "
                    "with its counters, formats, RTP address, SSRC, encryption and hold state: %s"
                    % caller_media)
print("media timeline of the transferred caller in %s: %s" % (onward["id"], caller_media))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(parent)[:1200])
PY
