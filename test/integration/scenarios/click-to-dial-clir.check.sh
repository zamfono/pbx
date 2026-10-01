#!/usr/bin/env bash
# §10.2 "Click-to-dial", §9.4 "Anonymous calls (CLIR)": the originated call is one `calls` row
# from 101 to the number, answered over the trunk, with the actor and its CLIR in the trace; and
# the one INVITE the trunk side received is the `both` layout of a withheld call, as `#31#` gives
# it: `From: "Anonymous" <sip:anonymous@anonymous.invalid>`, the presented number `+15551000` in
# P-Asserted-Identity, `Privacy: id`.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

call=$(api GET "/calls/$(cat "$(state_file originated)")")
printf '%s' "$call" \
  | python3 "$here/_originate-check.py" "$(user_with_ext 101)" +15557102 answered trunk
printf '%s' "$call" | PYTHONPATH="$here" python3 -c '
import json, sys
from _call_trace import trace
call = json.load(sys.stdin)
if not [l for l in trace(call) if l.get("event") == "originate" and l.get("clir") is True]:
    sys.exit("the originate line does not carry clir: true: " + json.dumps(call)[:800])
'
await_trace sipp /tmp/trunk-messages.log 1 | PYTHONPATH="$here" python3 -c '
import re, sys
from _sip_trace import received_invites

invites = received_invites(sys.stdin.read())
if len(invites) != 1:
    sys.exit("%d INVITEs reached the trunk side, not 1" % len(invites))
request, headers = invites[0]
values = lambda header: [value for name, value in headers if name == header]
problems = []
if "sip:+15557102@" not in request:
    problems.append("the INVITE was %r, not to +15557102" % request)
if [re.match(r"^\"Anonymous\" <sip:anonymous@anonymous\.invalid>", v) is not None
        for v in values("from")] != [True]:
    problems.append("From %s" % values("from"))
if [re.match(r"^<sip:\+15551000@[^>]+>$", v) is not None
        for v in values("p-asserted-identity")] != [True]:
    problems.append("P-Asserted-Identity %s" % values("p-asserted-identity"))
if values("privacy") != ["id"]:
    problems.append("Privacy %s" % values("privacy"))
if problems:
    sys.exit("the withheld click-to-dial: " + "; ".join(problems))
print("   withheld: From %s PAI %s" % (values("from"), values("p-asserted-identity")))
'
