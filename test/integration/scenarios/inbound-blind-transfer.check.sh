#!/usr/bin/env bash
# §10.1 "Transfers and pickup", blind transfer: the answered call closes when the member transfers
# it, and the caller's onward conversation is a `calls` row of its own with `parent_call_id` set
# to it. The onward call is the transferee's, an outside caller's, so it names no calling user,
# and it left over the trunk to the transfer target, which answered it.
set -euo pipefail

api_base=$1
token=$2

curl -fsS "$api_base/api/v1/calls" -H 'X-Forwarded-For: 127.0.0.1' \
  -H "Authorization: Bearer $token" | python3 -c '
import json, sys
calls = json.load(sys.stdin)["items"]
# Newest first: the most recent child is the one this scenario made.
child = next((c for c in calls if c["parentCallId"]), None)
if child is None:
    sys.exit("no call carries a parent_call_id")
parent = next((c for c in calls if c["id"] == child["parentCallId"]), None)
problems = []
if parent is None:
    problems.append("the parent call is missing from the history")
else:
    if parent["status"] != "answered" or not parent["answeredByUserId"]:
        problems.append("the transferred call was not recorded as answered by the member")
    if not parent["ringGroupId"]:
        problems.append("the transferred call lost its ring group")
    if not parent["endedAt"]:
        problems.append("the transferred call was never closed")
if child["status"] != "answered" or not child["endedAt"]:
    problems.append("the onward call did not end answered")
if "15557777" not in child["toUri"]:
    problems.append("the onward call did not go to the transfer target")
if child["callerUserId"]:
    problems.append("the onward call names a calling user, but its caller is the outside party")
# The same row a transfer over the API leaves: the onward call of the outside caller is still
# the inbound call it continues, through the DID of its parent.
if child["direction"] != "inbound":
    problems.append("the onward call of the inbound caller is " + child["direction"] + ", not inbound")
if parent is not None and (not parent["didId"] or child["didId"] != parent["didId"]):
    problems.append("the onward call did not keep the DID the caller dialled")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps({"parent": parent, "child": child}))
'
