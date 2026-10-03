#!/usr/bin/env bash
# §10.2 "Call parking" over the API: the park answered with a slot, `GET /parking/calls` listed
# the call there with its caller and its parker, and the click-to-dial to the slot retrieved it on
# the colleague's phone: the parked call names the colleague as its answerer, its trace the park
# and the retrieval, and at level `qos` (the setup) both the caller's leg and the colleague's
# received and sent audio, so the retrieved conversation ran both ways.
set -euo pipefail

api_base=$1
token=$2
here=$(dirname "$0")
# shellcheck source=_colleague.sh
. "$here/_colleague.sh"

accepted=$(bash "$here/_api-control-check.sh" 2)
read -r call_id slot originated <<<"$accepted"
parked=$(await_ended_call "$call_id" 15)
retrieval=$(await_ended_call "$originated" 15)
PYTHONPATH="$here" python3 - "$parked" "$retrieval" "$(cat "$(state_file api-control.parked)")" \
  "$slot" "$(user_with_ext 101)" "$(colleague_id colleague)" <<'PY'
import json, sys
from _call_trace import trace

parked, retrieval, listing = (json.loads(arg) for arg in sys.argv[1:4])
slot, parker, retriever = sys.argv[4:7]

problems = []
entries = [e for e in listing["items"] if e["callId"] == parked["id"]]
if [(e["slot"], e["caller"], e["parkedByUserId"]) for e in entries] != [
        (slot, "+15559999", parker)]:
    problems.append("parking.list did not show the call on slot %s, from +15559999, parked by 101: %s"
                    % (slot, listing))
if parked["status"] != "answered" or parked["answeredByUserId"] != retriever:
    problems.append("the parked call does not name the colleague as its answerer")
if not parked["endedAt"]:
    problems.append("the parked call was never closed")
lines = trace(parked)
if not [l for l in lines if l.get("event") == "parked" and l.get("by") == parker
        and l.get("ext") == slot and l.get("actorUserId")]:
    problems.append("no parked line names the parker, the slot and the acting user")
if not [l for l in lines if l.get("event") == "parkingRetrieved" and l.get("by") == retriever]:
    problems.append("no parkingRetrieved line names the colleague")
if retrieval["toUri"] != slot or retrieval["status"] != "answered":
    problems.append("the click-to-dial to the slot did not end answered")
answered = [l["channelId"] for l in trace(retrieval) if l.get("event") == "deviceAnswered"]
rows = {row["channelId"]: row for row in parked["qos"]}
callers = [row for row in parked["qos"] if row["role"] == "caller"]
for label, row in (("the caller's leg", callers[0] if callers else None),
                   ("the colleague's leg", rows.get(answered[0]) if answered else None)):
    if row is None:
        problems.append("the parked call has no call_qos row for %s" % label)
    elif not (row["rxPackets"] or 0) > 0 or not (row["txPackets"] or 0) > 0:
        problems.append("%s carried no audio both ways: %s" % (label, row))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(parked)[:1500])
print("   parked on %s, retrieved by the colleague; call_qos %s" % (slot, parked["qos"]))
PY
