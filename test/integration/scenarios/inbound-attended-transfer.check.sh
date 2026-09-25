#!/usr/bin/env bash
# §10.1 "Transfers and pickup", attended transfer: the answered call closes when the member
# transfers it, and the consultation call the member placed to the target carries the
# conversation on with `parent_call_id` set to it. Each row keeps its own parties, so the
# consultation still names the member as its caller; both rows are closed once the caller hangs
# up.
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
    if not parent["endedAt"]:
        problems.append("the transferred call was never closed")
    if child["callerUserId"] != parent["answeredByUserId"]:
        problems.append("the consultation call does not name the member who placed it")
if child["status"] != "answered":
    problems.append("the consultation call was not recorded as answered")
if not child["endedAt"]:
    problems.append("the consultation call was never closed")
if "15557777" not in child["toUri"]:
    problems.append("the consultation call did not go to the transfer target")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps({"parent": parent, "child": child}))
'
