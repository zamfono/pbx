#!/usr/bin/env bash
# §9.4 "Forwarded calls": both calls from +15559999 left over `ci-clip`, whose `forwardedCallerId`
# is `original`, to +15557303. Each INVITE presents the original caller in `From`
# (`<sip:+15559999@<FQDN>>`), carries exactly one `P-Asserted-Identity`, the number the leg
# presents under `own`, and no `P-Preferred-Identity`, and one `Diversion` naming the forward:
#
#   to +15551078, 179's forward   PAI <sip:+15551078@<FQDN>>, 179's own number;
#                                 Diversion "CI Clip" <sip:+15551078@…>;reason=unconditional
#   to +15551080, the DID's own   PAI <sip:+15551000@<FQDN>>, the main number, nobody's call;
#                                 Diversion "CI Clip Line" <sip:+15551080@…>;reason=unconditional
set -euo pipefail

api_base=$1
token=$2
compose=$3
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

sipp_trace sipp /tmp/trunk-messages.log | PYTHONPATH="$here" python3 -c '
import re, sys
from _sip_trace import received_invites

fqdn = sys.argv[1]
EXPECTED = [
    ("forward", "+15551078", r"^\"CI Clip\" <sip:\+15551078@[^>]+>;reason=unconditional$"),
    ("DID", "+15551000", r"^\"CI Clip Line\" <sip:\+15551080@[^>]+>;reason=unconditional$"),
]
invites = received_invites(sys.stdin.read())
problems = []
if len(invites) != len(EXPECTED):
    problems.append(f"{len(invites)} INVITEs reached the trunk side, not {len(EXPECTED)}")
for (request, headers), (leg, own, diversion_re) in zip(invites, EXPECTED):
    values = lambda header: [value for name, value in headers if name == header]
    froms, pais = values("from"), values("p-asserted-identity")
    ppis, diversions = values("p-preferred-identity"), values("diversion")
    print(f"   {leg}: {request} From {froms} PAI {pais} PPI {ppis} Diversion {diversions}")
    if "sip:+15557303@" not in request:
        problems.append(f"{leg}: the INVITE was {request!r}, not to +15557303")
    if len(froms) != 1 or not froms[0].startswith(f"<sip:+15559999@{fqdn}>"):
        problems.append(f"{leg}: From {froms}, not the original caller")
    if pais != [f"<sip:{own}@{fqdn}>"]:
        problems.append(f"{leg}: P-Asserted-Identity {pais}, not one naming {own}")
    if ppis:
        problems.append(f"{leg}: P-Preferred-Identity {ppis}, which original does not send")
    if len(diversions) != 1 or not re.search(diversion_re, diversions[0]):
        problems.append(f"{leg}: Diversion {diversions}, not one matching {diversion_re}")
if problems:
    sys.exit("; ".join(problems))
' "$FQDN"

newest_call | python3 -c '
import json, sys
call = json.load(sys.stdin)
if call["status"] != "answered":
    sys.exit("the DID-forwarded call ended " + call["status"] + ", not answered: "
             + json.dumps(call)[:800])
'
