#!/usr/bin/env bash
# §10.1 step 7 "HTTP requests": the request was sent once while the caller waited, a GET with the
# caller's number escaped in its query; its answer's tier matched the decision's `template`
# condition, so the call left a message in the group's mailbox and the phone was never offered
# it. The trace names the request before the decision, with its status and its URL without the
# query, and holds nothing of what was sent.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

invites=$(bash "$here/../phone.sh" "$compose" invites)
[ "$invites" = 0 ] || { echo "the phone was sent $invites INVITE(s)" >&2; exit 1; }

read -r _ request_id decision_id < "$(state_file inbound-http-request)"
voicemails=$(api GET /voicemails)
received=$(http_received)
newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

group, request_id, decision_id = sys.argv[1], sys.argv[2], sys.argv[3]
voicemails = json.loads(sys.argv[4])
requests = [json.loads(line) for line in sys.argv[5].splitlines() if line.strip()]
call = json.load(sys.stdin)
problems = []
if [(r["method"], r["url"]) for r in requests] != [("GET", "/lookup?caller=%2B15559999")]:
    problems.append("the receiver got %s" % json.dumps([(r["method"], r["url"]) for r in requests]))
if call["toUri"] != "+15551095" or call["status"] != "voicemail":
    problems.append("the call to %s ended %s, not in the mailbox" % (call["toUri"], call["status"]))
if not any(v["mailboxRingGroupId"] == group for v in voicemails["items"]):
    problems.append("the group mailbox holds no message")
lines = trace(call)
sent = [e for e in lines if e.get("event") == "httpRequest"]
taken = [e for e in lines if e.get("event") == "decision"]
if len(sent) != 1:
    problems.append("the trace has %d httpRequest lines" % len(sent))
else:
    line = sent[0]
    expected = {"httpRequestId": request_id, "method": "GET",
                "url": "http://10.213.48.1:8766/lookup", "status": 200}
    if {key: line.get(key) for key in expected} != expected or "error" in line:
        problems.append("the httpRequest line reads %s" % json.dumps(line))
    if not isinstance(line.get("durationMs"), int):
        problems.append("the httpRequest line has no duration")
if [(e.get("decisionId"), e.get("decisionCase")) for e in taken] != [(decision_id, 0)]:
    problems.append("the decision did not take its case for the answer")
elif sent and lines.index(sent[0]) > lines.index(taken[0]):
    problems.append("the decision was traced before the request")
if "15559999" in json.dumps(sent):
    problems.append("the trace holds the query")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
' "$(ci_group)" "$request_id" "$decision_id" "$voicemails" "$received"
