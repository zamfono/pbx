#!/usr/bin/env bash
# §9.4 "SIP targets", "Forwarded calls", §10.1 steps 2 and 7: the call to +15551077 left over the
# TLS trunk to `proj_ci123` at the trunk's host, bypassing the outbound routes, and was answered
# there. Its INVITE carries the target's headers as rendered (§9.4 "Header templates"): the
# original caller in `X-Zamfono-Caller`, the dialled DID in `X-Zamfono-Did`, 177, the user the call
# was for, in `X-Called`, and the last hop's reason in `X-Forward` beside a `${EXTEN}` sent as
# written; and one `Diversion`, the last hop's: 178's unconditional forward (Asterisk sends the
# redirecting party alone; 177's out-of-office hop is the leg's `REDIRECTING` original party, which
# chan_pjsip does not send). The history names 177 as the callee it was placed to. The trunk is
# `unmonitored` by then (`qualify` off, §9.4 "Provisioning and status"), so one answered attempt
# also shows the core tried a trunk nothing probes.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

# shellcheck disable=SC2016 -- the `${EXTEN}` is the literal text under test
await_trace sipp /tmp/sip-target-messages.log 1 \
  | python3 "$here/_forward-context-check.py" 'sip:proj_ci123@sip-tls:5061' \
    '^"CI Agent" <sip:178@[^>]+>;reason=unconditional$' \
    'X-Zamfono-Caller=+15559999' 'X-Zamfono-Did=+15551077' 'X-Called=177' \
    'X-Forward=unconditional ${EXTEN}'

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
