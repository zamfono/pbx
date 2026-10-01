#!/usr/bin/env bash
# §10.1 "Transfers and pickup" over the API, into a mailbox (§9.3 `*97<ext>`): the transfer was
# accepted, the answered call closed with the transfer to `*97101` in its trace, and the caller's
# onward call, linked to it through `parent_call_id`, ended in 101's mailbox, which holds a new
# message from the caller.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

read -r code call_id < "$(state_file api-deposit)" || true
if [[ ${code:-none} != 2?? ]]; then
  echo "the API transfer to voicemail was not accepted (HTTP ${code:-none}):" \
    "$(cat "$(state_file api-deposit.log)" 2>/dev/null)" >&2
  exit 1
fi
parent=$(await_ended_call "$call_id" 15)
python3 - "$parent" "$(api GET /calls)" "$(api GET /voicemails)" \
  "$(cat "$(state_file api-deposit-before)")" "$(user_with_ext 101)" <<'PY'
import json, sys

parent, calls, voicemails = (json.loads(arg) for arg in sys.argv[1:4])
before, mailbox = set(sys.argv[4].split()), sys.argv[5]
lines = [json.loads(line) for line in (parent.get("log") or "").splitlines() if line.strip()]

problems = []
if not [l for l in lines if l.get("event") == "transfer" and l.get("target") == "*97101"
        and l.get("actorUserId")]:
    problems.append("the call's trace has no transfer to *97101 naming the acting user")
child = next((c for c in calls["items"] if c["parentCallId"] == parent["id"]), None)
if child is None:
    problems.append("no onward call carries the transferred call as its parent")
elif child["status"] != "voicemail" or not child["endedAt"]:
    problems.append("the onward call ended %s, not in the mailbox" % child["status"])
new = [v for v in voicemails["items"] if v["id"] not in before]
if [(v["mailboxUserId"], v["caller"]) for v in new] != [(mailbox, "+15559999")]:
    problems.append("101's mailbox holds no new message from +15559999: %s" % new)
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(parent)[:1200])
PY
