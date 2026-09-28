"""A sipp `-trace_msg` message file read back, for the checks that assert on what a trunk side
received and answered (`_callerid-check.py`, `_emergency-check.py`)."""
import re


def messages(trace):
    """Every traced message in order: whether it was `received` or `sent`, its start line and its
    headers as lower-cased `(name, value)` pairs."""
    result = []
    for block in re.split(r"\n-{10,}[^\n]*\n", "\n" + trace.replace("\r", "")):
        direction = ("received" if "message received" in block
                     else "sent" if "message sent" in block else None)
        if direction is None:
            continue
        lines = block.split("\n")
        start = next((i for i, line in enumerate(lines)
                      if line.startswith("SIP/2.0 ") or re.match(r"^[A-Z]+ \S+ SIP/2\.0$", line)),
                     None)
        if start is None:
            continue
        headers = []
        for line in lines[start + 1:]:
            if not line.strip():
                break
            name, _, value = line.partition(":")
            headers.append((name.strip().lower(), value.strip()))
        result.append((direction, lines[start], headers))
    return result


def received_invites(trace):
    """Each received INVITE's request line and headers, the first per Call-ID (a retransmission
    shares its call's Call-ID)."""
    invites, seen = [], set()
    for direction, start, headers in messages(trace):
        if direction != "received" or not start.startswith("INVITE "):
            continue
        call_id = next((value for name, value in headers if name == "call-id"), None)
        if call_id in seen:
            continue
        seen.add(call_id)
        invites.append((start, headers))
    return invites
