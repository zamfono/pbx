#!/usr/bin/env bash
# §10.1 step 7 "Fallback and ring timeout": the bot's socket did not open
# (inbound-forward-fallback.setup.sh), so the call went to the target's fallback, the external
# number, and was answered over the trunk: the trunk side received one INVITE to it, and the trace
# names the bot's failure and the fallback taken, with no 503 release.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

sipp_trace sipp /tmp/trunk-messages.log | PYTHONPATH="$here" python3 -c '
import sys
from _sip_trace import received_invites

invites = received_invites(sys.stdin.read())
if [request for request, _ in invites if "sip:+15557777@" in request] == []:
    sys.exit("no INVITE to the fallback +15557777 reached the trunk side: %r" % invites)
'

newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

call = json.load(sys.stdin)
lines = trace(call)
problems = []
if call["status"] != "answered":
    problems.append("the call ended " + call["status"] + ", not answered")
if not [l for l in lines if l.get("event") == "webSocket" and l.get("cause") == "connectFailed"]:
    problems.append("no webSocket connectFailed line")
if not [l for l in lines if l.get("event") == "fallback" and l.get("from") == "webSocket"
        and l.get("cause") == "connectFailed" and l.get("to") == "external"]:
    problems.append("no fallback line from the bot to the external number")
if [l for l in lines if l.get("event") == "release" and l.get("code") == 503]:
    problems.append("the call was released with 503")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:800])
'
