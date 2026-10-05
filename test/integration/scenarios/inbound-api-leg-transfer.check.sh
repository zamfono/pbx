#!/usr/bin/env bash
# §10.3 "Live calls", §10.1 "Transfers and pickup": the live call listed its two legs, neither a
# user's, the caller's on the trunk it arrived on and the SIP target's on the trunk it left by,
# with its target; the admin's transfer naming the caller's leg was accepted. The call closed
# answered with the transfer in its trace, and its log holds the BYE that released the SIP
# target's side and the target's 200 to it (§7 level `sip`). The caller's onward call, linked to
# it through `parent_call_id`, was answered by 101.
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
PYTHONPATH="$here" python3 - "$parent" "$(api GET /calls)" \
  "$(cat "$(state_file api-control.legs)")" "$leg_id" "$(user_with_ext 101)" \
  "$(trunk_named ci-trunk)" <<'PY'
import json, re, sys
from _call_trace import trace

parent, calls, legs = (json.loads(arg) for arg in sys.argv[1:4])
leg_id, member, trunk = sys.argv[4:7]

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
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(parent)[:1200])
PY
