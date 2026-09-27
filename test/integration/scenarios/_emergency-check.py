"""The four trunk sides' view of `outbound-emergency-trunk-order` (§10.1 "Emergency calls", §9.4
"Trunk order", "Emergency trunks"): the messages each one's sipp traced, checked for the INVITEs
it received and what it answered them with.

  1  emergency, refuses       exactly one INVITE, to 112, answered 503
  2  not emergency            no INVITE at all, though its qualify was answered
  3  emergency, answers       exactly one INVITE, to 112, answered 200, presenting the caller's
                              own number (the main number, 101 has none of their own), shown
  4  emergency, catch-all     exactly one INVITE opening a call, the control call's, and none
                              to 112, in a dialog or out of one

Usage: python3 _emergency-check.py <trace-1> <trace-2> <trace-3> <trace-4> <control-number>
"""
import re
import sys

from _sip_trace import messages, received_invites

PRESENTED = r"^<sip:\+15551000@[^>]+>"


def read(path):
    with open(path, encoding="utf-8", errors="replace") as trace:
        return trace.read()


def sent_statuses(trace):
    """The status line of every response sent to an INVITE, one per distinct status."""
    return sorted({start.split(" ", 2)[1] for direction, start, headers in messages(trace)
                   if direction == "sent" and start.startswith("SIP/2.0 ")
                   and any(name == "cseq" and value.endswith("INVITE")
                           for name, value in headers)})


def called(invites):
    return [re.sub(r"^INVITE sip:([^@;>]+).*$", r"\1", start) for start, _ in invites]


def to_users(invites):
    return [re.sub(r"^.*<sip:([^@;>]+).*$", r"\1", value)
            for _, headers in invites for name, value in headers if name == "to"]


traces = [read(path) for path in sys.argv[1:5]]
control = sys.argv[5]
invites = [received_invites(trace) for trace in traces]
problems = []
# `ci-trunk`'s side serves every scenario's calls from the same address, and Asterisk keeps
# retransmitting an earlier scenario's re-INVITE that side never answered (seen after
# `outbound-callerid`, To-tagged, for its +15557101/2 calls) into this trace: an INVITE inside a
# dialog opens no call and is reported, not counted, unless it is for 112.
calls = received_invites(traces[3], in_dialog=False)
for start, headers in invites[3]:
    if called([(start, headers)]) != [control]:
        where = "opening a call" if (start, headers) in calls else "inside a dialog"
        print(f"   trunk 4, {where}: {start} " + " ".join(
            f"{name}: {value}" for name, value in headers
            if name in ("from", "to", "call-id", "cseq", "user-agent")))
if "112" in called(invites[3]) + to_users(invites[3]):
    problems.append(f"trunk 4 got an INVITE for 112: {called(invites[3])}")

if called(invites[0]) != ["112"] or sent_statuses(traces[0]) != ["503"]:
    problems.append(f"trunk 1 got INVITEs to {called(invites[0])}, answered "
                    f"{sent_statuses(traces[0])}, not one to 112 answered 503")
options = [start for direction, start, _ in messages(traces[1])
           if direction == "received" and start.startswith("OPTIONS ")]
if invites[1] or not options:
    problems.append(f"trunk 2 got INVITEs to {called(invites[1])} and {len(options)} OPTIONS, "
                    "not qualified and never tried")
if called(invites[2]) != ["112"] or "200" not in sent_statuses(traces[2]):
    problems.append(f"trunk 3 got INVITEs to {called(invites[2])}, answered "
                    f"{sent_statuses(traces[2])}, not one to 112 answered 200")
for _, headers in invites[2][:1]:
    values = lambda header: [value for name, value in headers if name == header]
    froms, pais, privacies = values("from"), values("p-asserted-identity"), values("privacy")
    if len(froms) != 1 or not re.search(PRESENTED, froms[0]) or "anonymous" in froms[0].lower():
        problems.append(f"trunk 3's INVITE presented From {froms}, not the main number, shown")
    if any(not re.search(PRESENTED, pai) for pai in pais):
        problems.append(f"trunk 3's INVITE asserted {pais}, not the main number")
    if privacies:
        problems.append(f"trunk 3's INVITE withheld the number: Privacy {privacies}")
    print(f"   trunk 3: From {froms} PAI {pais} Privacy {privacies}")
if called(calls) != [control]:
    problems.append(f"trunk 4 got calls to {called(calls)}, not the control call's {control} "
                    "alone")
if problems:
    sys.exit("; ".join(problems))
print(f"   112: 503 on trunk 1, trunk 2 passed by, answered on trunk 3; {control} on trunk 4")
