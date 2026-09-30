"""The trunk side's view of a forwarded leg (§9.4 "SIP targets", "Forwarded calls", "Header
templates"): the one INVITE sipp traced as received, its size, request URI, To, custom headers and
Diversion, each printed verbatim and checked against what the scenario's forwarding chain should
give.

Usage: python3 _forward-context-check.py <request-uri> <diversion-regex> [<name>=<value> ...]
                                         < <sipp message trace>

Each <name>=<value> is a custom `X-` header the INVITE must carry exactly once with that value, and
it must carry no other `X-` header: none at all for an `external` forward. The Diversion must be
exactly one header field matching <diversion-regex>, the core's own under the trunk's
`trunks.diversion`, its entries comma-separated and each naming the host of the INVITE's own
`From`; a <diversion-regex> of `-` wants none, a trunk whose `diversion` is `off`. No
`History-Info` either way: chan_pjsip sends neither (`send_diversion = no`, `send_history_info`
at its default).
"""
import re
import sys

from _sip_trace import received_invites

request_uri, diversion_re = sys.argv[1:3]
expected = dict(arg.split("=", 1) for arg in sys.argv[3:])
trace = sys.stdin.read()
invites = received_invites(trace)
if len(invites) != 1:
    sys.exit(f"{len(invites)} INVITEs reached the trunk side, not 1")
request, headers = invites[0]
values = lambda header: [value for name, value in headers if name == header]
size = re.search(r"message received \[(\d+)\] bytes[^\n]*\n\s*\n" + re.escape(request),
                 trace.replace("\r", ""))
print(f"   {request} ({size.group(1) if size else '?'} bytes)")
for name, value in headers:
    if name in ("to", "from", "diversion", "history-info") or name.startswith("x-"):
        print(f"   {name}: {value}")

problems = []
if request != f"INVITE {request_uri} SIP/2.0":
    problems.append(f"the INVITE was {request!r}, not to {request_uri}")
custom = sorted((name, value) for name, value in headers if name.startswith("x-"))
wanted = sorted((name.lower(), value) for name, value in expected.items())
if custom != wanted:
    problems.append(f"custom headers {custom}, not {wanted}")
diversions = values("diversion")
if diversion_re == "-":
    if diversions:
        problems.append(f"Diversion {diversions}, though the trunk sends none")
elif len(diversions) != 1 or not re.search(diversion_re, diversions[0]):
    problems.append(f"Diversion {diversions}, not one field matching {diversion_re}")
else:
    from_host = re.search(r"sip:[^@>;]*@([^:;>]+)", (values("from") or [""])[0])
    hosts = set(re.findall(r"<sip:[^@>]*@([^:;>]+)", diversions[0]))
    if from_host is None or hosts != {from_host.group(1)}:
        problems.append(f"Diversion hosts {sorted(hosts)}, not the From's "
                        f"{from_host.group(1) if from_host else None}")
if values("history-info"):
    problems.append(f"History-Info {values('history-info')}, which the trunk does not send")
if problems:
    sys.exit("; ".join(problems))
