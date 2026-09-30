"""The trunk side's view of a forwarded leg (§9.4 "SIP targets", "Forwarded calls"): the one INVITE
sipp traced as received, its request URI, To, custom headers and Diversion, each printed verbatim
and checked against what the scenario's forwarding chain should give.

Usage: python3 _forward-context-check.py <request-uri> <caller|-> <did|-> <diversion-regex>
                                         < <sipp message trace>

`-` for the caller or the DID means the header must be absent. The Diversion must be exactly one
header matching <diversion-regex>: Asterisk sends the last hop's alone (`res_pjsip_diversion`).
"""
import re
import sys

from _sip_trace import received_invites

request_uri, caller, did, diversion_re = sys.argv[1:5]
invites = received_invites(sys.stdin.read())
if len(invites) != 1:
    sys.exit(f"{len(invites)} INVITEs reached the trunk side, not 1")
request, headers = invites[0]
values = lambda header: [value for name, value in headers if name == header]
print(f"   {request}")
for name in ("to", "from", "diversion", "history-info", "x-zamfono-caller", "x-zamfono-did"):
    for value in values(name):
        print(f"   {name}: {value}")

problems = []
if request != f"INVITE {request_uri} SIP/2.0":
    problems.append(f"the INVITE was {request!r}, not to {request_uri}")
for header, expected in (("x-zamfono-caller", caller), ("x-zamfono-did", did)):
    if values(header) != ([] if expected == "-" else [expected]):
        problems.append(f"{header} {values(header)}, not {expected}")
diversions = values("diversion")
if len(diversions) != 1 or not re.search(diversion_re, diversions[0]):
    problems.append(f"Diversion {diversions}, not one matching {diversion_re}")
if values("history-info"):
    problems.append(f"History-Info {values('history-info')}, which the trunk does not send")
if problems:
    sys.exit("; ".join(problems))
