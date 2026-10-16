"""A sipp `-trace_msg` message file or a baresip `-s` log read back, for the checks that assert on
what a trunk side received and answered (`_callerid-check.py`, `_emergency-check.py`,
`_forward-context-check.py`). baresip's trace names each message's addresses but not its
direction, so a baresip log needs `SIP_TRACE_LOCAL`, the `<ip>:<port>` it listened on: what came
to that address was received."""
import os
import re

# baresip's trace block: `<time>#`, `<transport> <src> -> <dst>`, the message, in ANSI colour.
BARESIP_BLOCK = re.compile(r"\x1b\[36;1m[^\n]*#\n\S+ (\S+) -> (\S+)\n(.*?)\x1b\[;m", re.S)


def blocks(trace):
    """Each traced message as `(direction, text)`, from either tool's trace."""
    trace = trace.replace("\r", "")
    if BARESIP_BLOCK.search(trace):
        local = os.environ["SIP_TRACE_LOCAL"]
        return [("received" if dst == local else "sent", text)
                for _, dst, text in BARESIP_BLOCK.findall(trace)]
    return [("received" if "message received" in block
             else "sent" if "message sent" in block else None, block)
            for block in re.split(r"\n-{10,}[^\n]*\n", "\n" + trace)]


def messages(trace):
    """Every traced message in order: whether it was `received` or `sent`, its start line and its
    headers as lower-cased `(name, value)` pairs."""
    result = []
    for direction, block in blocks(trace):
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
