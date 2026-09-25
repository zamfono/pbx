"""The history check the inbound trunk scenarios share (§9.4 "Inbound numbers", "Inbound number
normalization"): the newest call is the one the scenario placed, it matched the DID by its
normalized called number, carries the normalized caller, was answered through the ring group,
and its routing trace names the trunk that identified it.

Usage: python3 _inbound-trunk-check.py <trunk-id> <did-id> <to> <from> < GET /calls/{id}

The call is read from stdin, `calls.get`'s detail with its `log`.
"""
import json
import sys

trunk_id, did_id, expected_to, expected_from = sys.argv[1:5]
call = json.load(sys.stdin)

trunks = []
for line in (call.get("log") or "").splitlines():
    try:
        entry = json.loads(line)
    except ValueError:
        continue
    if isinstance(entry, dict) and entry.get("event") == "trunk":
        trunks.append(entry.get("trunkId"))

problems = []
if call["toUri"] != expected_to:
    problems.append(f"the called number reached the pipeline as {call['toUri']!r}, not {expected_to!r}")
if call["fromUri"] != expected_from:
    problems.append(f"the caller reached the pipeline as {call['fromUri']!r}, not {expected_from!r}")
if call["didId"] != did_id:
    problems.append("the call did not match the DID")
if call["status"] != "answered" or not call["answeredByUserId"] or not call["ringGroupId"]:
    problems.append("the call was not answered through the ring group")
if not call["endedAt"]:
    problems.append("the call was never closed")
if trunks != [trunk_id]:
    problems.append(f"the routing trace names trunks {trunks}, not {trunk_id}")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call))
