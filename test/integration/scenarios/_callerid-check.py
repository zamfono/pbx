"""The trunk side's view of `outbound-callerid` (§9.4 "Caller-ID", "Anonymous calls (CLIR)"):
the INVITEs sipp traced as received, in order, one per call (a retransmission shares its call's
Call-ID), each checked for the From, P-Asserted-Identity and Privacy its trunk's layout gives.

Usage: python3 _callerid-check.py <trunk-host> < /tmp/trunk-messages.log
"""
import re
import sys

from _sip_trace import received_invites

trunk_host = re.escape(sys.argv[1])
PRESENTED = r"<sip:\+15551000@[^>]+>"
ACCOUNT = rf"<sip:ci-pai-acct@{trunk_host}>"
# Per call: the called number, what From must start with, the one PAI (or none), Privacy.
EXPECTED = [
    ("+15557777", "from, shown", rf"^{PRESENTED}", None, None),
    ("+15557101", "pai, shown", rf"^{ACCOUNT}", rf"^<sip:\+15551000@{trunk_host}>$", None),
    ("+15557101", "pai, withheld", rf'^"Anonymous" {ACCOUNT}',
     rf"^<sip:\+15551000@{trunk_host}>$", "id"),
    ("+15557102", "both, shown", rf"^{PRESENTED}", rf"^{PRESENTED}$", None),
    ("+15557102", "both, withheld", r'^"Anonymous" <sip:anonymous@anonymous\.invalid>',
     rf"^{PRESENTED}$", "id"),
]


problems = []
invites = received_invites(sys.stdin.read())
if len(invites) != len(EXPECTED):
    problems.append(f"{len(invites)} INVITEs reached the trunk side, not {len(EXPECTED)}")
for (request, headers), (number, layout, from_re, pai_re, privacy) in zip(invites, EXPECTED):
    values = lambda header: [value for name, value in headers if name == header]
    froms, pais, privacies = values("from"), values("p-asserted-identity"), values("privacy")
    if f"sip:{number}@" not in request:
        problems.append(f"{layout}: the INVITE was {request!r}, not to {number}")
    if len(froms) != 1 or not re.search(from_re, froms[0]):
        problems.append(f"{layout}: From {froms}")
    if (pai_re is None and pais) or (pai_re is not None and (
            len(pais) != 1 or not re.search(pai_re, pais[0]))):
        problems.append(f"{layout}: P-Asserted-Identity {pais}")
    if privacies != ([] if privacy is None else [privacy]):
        problems.append(f"{layout}: Privacy {privacies}")
    print(f"   {layout}: From {froms} PAI {pais} Privacy {privacies}")
if problems:
    sys.exit("; ".join(problems))
print(f"   {len(invites)} INVITEs with the header layout of their trunk")
