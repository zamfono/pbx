#!/usr/bin/env bash
# §9.4 "SIP targets", "Forwarded calls", §10.1 steps 2 and 7: the call to +15551077 left over the
# TLS trunk to `proj_ci123` at the trunk's host, bypassing the outbound routes, and was answered
# there. Its INVITE carries the original caller in `X-Zamfono-Caller`, the dialled DID in
# `X-Zamfono-Did`, and one `Diversion`, the last hop's: 178's unconditional forward (Asterisk
# sends the redirecting party alone; 177's out-of-office hop is the leg's `REDIRECTING` original
# party, which chan_pjsip does not send). The history names 177 as the callee it was placed to.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

# shellcheck disable=SC2086 -- `$compose` carries the runtime's own multi-word command
$compose exec -T sipp cat /tmp/sip-target-messages.log \
  | python3 "$here/_forward-context-check.py" 'sip:proj_ci123@sip-tls:5061' \
    '+15559999' '+15551077' '^"CI Agent" <sip:178@[^>]+>;reason=unconditional$'

newest_call | python3 -c '
import json, sys

call = json.load(sys.stdin)
events = [json.loads(line) for line in (call.get("log") or "").splitlines() if line.strip()]
attempts = [event for event in events if event.get("event") == "attempt"]
problems = []
if call["status"] != "answered":
    problems.append("the call ended " + call["status"] + ", not answered")
if call["answeredByUserId"]:
    problems.append("a user answered the call, instead of the sip target over the trunk")
if len(attempts) != 1 or attempts[0].get("routeId") is not None \
        or attempts[0].get("cause") != "answered":
    problems.append("not one route-less answered attempt: " + json.dumps(attempts))
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:800])
'
