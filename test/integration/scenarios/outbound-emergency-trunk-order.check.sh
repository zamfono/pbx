#!/usr/bin/env bash
# §10.1 "Emergency calls", §9.4 "Trunk order", "Emergency trunks": `112` bypassed the outbound
# routes and was tried on the emergency trunks alone, in trunk order. What each trunk side
# traced (`_emergency-check.py`): the first emergency trunk got the INVITE and refused it 503,
# the unflagged trunk between got none, the next emergency trunk answered it presenting the
# caller's own number, shown, and `ci-trunk`, emergency too and the catch-all route's trunk, got
# the control call's INVITE alone. The history agrees: the control call's one attempt answered
# on `ci-trunk`; the emergency call's routing trace has one line per attempt, 503 on the first
# trunk, then the answer on the third, and nothing else.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

CONTROL=+15557401

traces=$(mktemp -d)
trap 'rm -rf "$traces"' EXIT
# Each trunk side's trace once it holds the INVITEs it should (trunk 2 none) and is written out.
for side in 1:1 2:0 3:1; do
  await_trace sipp-provider "/tmp/emergency-${side%:*}-messages.log" "${side#*:}" \
    > "$traces/${side%:*}.log"
done
await_trace sipp /tmp/trunk-messages.log 1 > "$traces/4.log"
python3 "$(dirname "$0")/_emergency-check.py" \
  "$traces/1.log" "$traces/2.log" "$traces/3.log" "$traces/4.log" "$CONTROL"

read -r refuse_id _ answer_id ci_id < "$(state_file emergency-order)"
calls=$(api GET /calls)
emergency=$(api GET "/calls/$(printf '%s' "$calls" | jsonfield items.0.id)")
control=$(api GET "/calls/$(printf '%s' "$calls" | jsonfield items.1.id)")
python3 -c '
import json, sys

emergency, control = json.loads(sys.argv[1]), json.loads(sys.argv[2])
refuse, answer, ci, number = sys.argv[3:7]


def trace(call, event):
    lines = [json.loads(line) for line in (call.get("log") or "").splitlines() if line.strip()]
    return [(line.get("trunkId"), line.get("cause")) for line in lines
            if isinstance(line, dict) and line.get("event") == event]


problems = []
for call, to, attempts in ((control, number, [(ci, "answered")]),
                           (emergency, "112", [(refuse, 503), (answer, "answered")])):
    dialled, status, attempted = call["toUri"], call["status"], trace(call, "attempt")
    if dialled != to or status != "answered":
        problems.append(f"the call to {dialled!r} ended {status!r}, not {to} answered")
    if attempted != attempts:
        problems.append(f"the call to {to} attempted {attempted}, not {attempts}")
tried = [trunk for trunk, _ in trace(emergency, "emergencyAttempt")]
if tried != [refuse, answer]:
    problems.append(f"the emergency call tried {tried}, not {[refuse, answer]}")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps([emergency, control]))
' "$emergency" "$control" "$refuse_id" "$answer_id" "$ci_id" "$CONTROL"
