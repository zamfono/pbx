#!/usr/bin/env bash
# §9.4 "Forwarded calls", §10.1 step 7: the call to +15551077 left over `ci-divert-last`, whose
# `diversion` is `last`, to +15557301 and was answered there. Its INVITE carries one `Diversion`
# field with one entry, the newest hop's alone: 178's unconditional forward by the main number,
# 178 having none of its own, never 178's extension; 177's out-of-office hop, which `all` would
# add after it, is left out. No custom header: an external forward carries none. The history
# records the call answered over the trunk, by no user.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

await_trace sipp /tmp/trunk-messages.log 1 \
  | python3 "$here/_forward-context-check.py" "sip:+15557301@$(container_ip sipp)" \
    '^"CI Agent" <sip:\+15551000@[^>]+>;reason=unconditional$'

newest_call | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace

call = json.load(sys.stdin)
events = trace(call)
attempts = [event for event in events if event.get("event") == "attempt"]
problems = []
if call["status"] != "answered":
    problems.append("the call ended " + call["status"] + ", not answered")
if call["answeredByUserId"]:
    problems.append("a user answered the call, instead of the external number over the trunk")
if len(attempts) != 1 or attempts[0].get("cause") != "answered":
    problems.append("not one answered attempt: " + json.dumps(attempts))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:800])
'
