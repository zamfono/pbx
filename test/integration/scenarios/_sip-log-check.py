"""Shared check of the `*-sip-log-*` scenarios (§7 level `sip`).

Reads the newest call (`GET /calls/{id}`) on stdin and asserts that it went to the number given
as the first argument and that its `log` holds, among its SIP lines, one message per further
argument, each `<direction> <first-line regex>`: `in ^INVITE ` is an INVITE Asterisk received,
`out ^SIP/2\\.0 200 ` a 200 it sent. Only a message Asterisk actually mirrored over HEP, and the
core joined to the call by its Call-ID, can be there, so a stack whose res_hep sends nothing
(a hostname in hep.conf's capture_address) or that files a message under the wrong direction
fails here.

    newest_call | python3 _sip-log-check.py +15551000 'in ^INVITE ' 'out ^SIP/2\\.0 200 '
"""

import json
import re
import sys


def main() -> None:
    to = sys.argv[1]
    expected = [arg.split(" ", 1) for arg in sys.argv[2:]]
    call = json.load(sys.stdin)
    messages = []
    for line in (call.get("log") or "").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("raw"), str):
            first = entry["raw"].lstrip().split("\r\n", 1)[0].split("\n", 1)[0]
            messages.append((entry.get("direction"), first))

    problems = []
    if call.get("toUri") != to:
        problems.append(f"the newest call went to {call.get('toUri')!r}, not {to}")
    for direction, pattern in expected:
        if not any(d == direction and re.search(pattern, first) for d, first in messages):
            problems.append(f"no {direction} message matching {pattern!r}")
    if problems:
        summary = "\n  ".join(f"{d} {first}" for d, first in messages) or "none"
        sys.exit("; ".join(problems) + f"\nthe call's SIP messages:\n  {summary}")


main()
