"""A call's trace (§7 `calls.log`), the JSON lines `GET /calls/{id}` carries as `log`, read back
for the checks that assert on what the call recorded."""
import json


def trace(call):
    """Every entry the call's log holds, in order: the routing events, and at level `sip` the SIP
    messages; none while the log is empty."""
    return [json.loads(line) for line in (call.get("log") or "").splitlines() if line.strip()]
