#!/usr/bin/env bash
# §9.4 "Inbound identification", "Inbound numbers": the call came from the `ip` trunk's own
# address, so it is that trunk's, recorded in the routing trace; its E.164 numbers pass the
# `e164` boundary unchanged and the called number matched the main DID. §9.3 "NAT": every request
# Asterisk sent the phone, the call's INVITE and the OPTIONS probes alike, names the stack's FQDN,
# the domain the device registered in, as its `From` host.
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(dirname "$0")
# shellcheck source=_lib.sh
. "$here/_lib.sh"

trunk_id=$(api GET /trunks | python3 -c "
import json, sys
print([t['id'] for t in json.load(sys.stdin)['items'] if t['name'] == 'ci-trunk'][0])
")
did_id=$(api GET /dids | python3 -c "
import json, sys
print([d['id'] for d in json.load(sys.stdin)['items'] if d['number'] == '+15551000'][0])
")
newest_call | python3 "$here/_inbound-trunk-check.py" \
  "$trunk_id" "$did_id" +15551000 +15559999
sipp_trace sipp-phone /tmp/phone-messages.log | PYTHONPATH="$here" python3 -c '
import re, sys
from _sip_trace import messages

fqdn = sys.argv[1]
requests = [(start.split(" ", 1)[0], [v for n, v in headers if n == "from"])
            for direction, start, headers in messages(sys.stdin.read())
            if direction == "received" and not start.startswith("SIP/2.0 ")]
if "INVITE" not in [method for method, _ in requests]:
    sys.exit("no INVITE reached the phone")
wrong = [(method, froms) for method, froms in requests
         if len(froms) != 1 or not re.search(r"<sips?:[^@>]*@" + re.escape(fqdn) + r"[;>]", froms[0])]
if wrong:
    sys.exit("requests to the phone whose From host is not %s: %s" % (fqdn, wrong[:5]))
print("   %d requests to the phone, each From the FQDN %s" % (len(requests), fqdn))
' "$FQDN"
