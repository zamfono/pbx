#!/usr/bin/env bash
# §10.3 "Live calls", §10.1 "Transfers and pickup": 101's outbound call listed its two legs, 101's
# own as the caller's and the far end's on the trunk with the number it dialled; the admin's
# transfer naming the far end's leg was accepted. The call closed answered with the transfer in
# its trace, and the far end's onward call, linked to it through `parent_call_id`, was answered
# by 102.
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_colleague.sh
. "$here/_colleague.sh"

read -r call_id leg_id <<<"$(bash "$here/_api-control-check.sh" 1)"
if [ "$call_id" != "$(cat "$(state_file originated)")" ]; then
  echo "the transfer acted on $call_id, not the originated call" >&2
  exit 1
fi
PYTHONPATH="$here" python3 - "$(api GET "/calls/$call_id")" "$(api GET /calls)" \
  "$(cat "$(state_file api-control.legs)")" "$leg_id" "$(user_with_ext 101)" \
  "$(colleague_id colleague)" "$(trunk_named ci-trunk)" <<'PY'
import json, sys
from _call_trace import trace

parent, calls, legs = (json.loads(arg) for arg in sys.argv[1:4])
leg_id, member, colleague, trunk = sys.argv[4:8]

problems = []
roles = [(leg["role"], leg.get("userId"), leg.get("trunkId"), leg.get("target")) for leg in legs]
if roles != [("caller", member, None, None), ("callee", None, trunk, "+15557502")]:
    problems.append("the live call's legs are not 101's and the far end's: %s" % legs)
if len(legs) == 2 and legs[1]["id"] != leg_id:
    problems.append("the transfer named %s, not the far end's leg" % leg_id)
if parent["status"] != "answered" or parent["direction"] != "outbound":
    problems.append("the call is %s %s, not an answered outbound call"
                    % (parent["status"], parent["direction"]))
if not [l for l in trace(parent) if l.get("event") == "transfer" and l.get("target") == "102"
        and l.get("actorUserId")]:
    problems.append("the call's trace has no transfer to 102 naming the acting user")
child = next((c for c in calls["items"] if c["parentCallId"] == parent["id"]), None)
if child is None:
    problems.append("no onward call carries the transferred call as its parent")
elif child["status"] != "answered" or child["answeredByUserId"] != colleague:
    problems.append("the onward call ended %s, answered by %s, not by 102"
                    % (child["status"], child["answeredByUserId"]))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(parent)[:1200])
PY
