#!/usr/bin/env bash
# §8 "forwarding chains", §10.1 step 5: the ring group's only member forwards unconditionally to
# an external number (inbound-forward-external.setup.sh), so the call still reaches the group but
# is answered over the trunk rather than by any user — the call history still carries the group
# that routed it, but no answering user (§10.2 "Call history").
set -euo pipefail

api_base=$1
token=$2
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=_lib.sh
. "$here/_lib.sh"

group_id=$(ci_group)
newest_call | python3 -c '
import json, sys

group = sys.argv[1]
call = json.load(sys.stdin)

problems = []
if call["ringGroupId"] != group:
    problems.append("the call did not reach the group")
if call["status"] != "answered":
    problems.append("the call ended " + call["status"] + ", not answered")
if call["answeredByUserId"]:
    problems.append("a member answered the call directly, instead of the forward leaving it over the trunk")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:600])
' "$group_id"
