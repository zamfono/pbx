#!/usr/bin/env bash
# §9.4 "Caller-ID", "Anonymous calls (CLIR)": the INVITEs the trunk side received carry the
# header layout of the trunk each left over, the presented number being the main number
# `+15551000` (101 has no number of their own):
#
#   from, shown     From: <sip:+15551000@…>, no P-Asserted-Identity, no Privacy
#   pai, shown      From: <sip:ci-pai-acct@<trunk host>>, one PAI <sip:+15551000@<trunk host>>
#   pai, withheld   the same account identity in From, the same PAI, Privacy: id
#   both, shown     From: <sip:+15551000@…>, one PAI <sip:+15551000@…>
#   both, withheld  From: "Anonymous" <sip:anonymous@anonymous.invalid>, the same PAI, Privacy: id
#
# and none of them is followed by an INVITE or UPDATE inside its dialog, which would re-assert the
# party the call was bridged to instead of the presented number (the trunks' `send_connected_line`).
#
# The withheld call over the `from` trunk sent no INVITE at all: its one route was skipped for CLIR
# and the call refused with 403.
set -euo pipefail

api_base=$1
token=$2
compose=$3
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

trunk_ip=$(container_ip sipp)
await_trace sipp /tmp/trunk-messages.log 5 \
  | python3 "$(dirname "$0")/_callerid-check.py" "$trunk_ip"

newest_call | python3 -c '
import json, sys
call = json.load(sys.stdin)
events = [json.loads(line) for line in (call.get("log") or "").splitlines() if line.strip()]
causes = [event.get("cause") for event in events if event.get("event") == "attempt"]
releases = [event.get("code") for event in events if event.get("event") == "release"]
if call["status"] != "failed" or causes != ["clirUnsupported"] or releases != [403]:
    sys.exit("the withheld call over the from trunk was not skipped and refused 403: "
             + json.dumps(call))
'
