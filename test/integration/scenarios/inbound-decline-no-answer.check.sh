#!/usr/bin/env bash
# §10.1 step 4, §11.2 `calls.status`: a ring whose only device declined with 603 fell to the
# `noAnswer` rule, released 480 and recorded `missed`; the `busy` rule, reserved for 486 and 600,
# would have recorded `busy`.
set -euo pipefail

api_base=$1
token=$2
# shellcheck source=_lib.sh
. "$(dirname "$0")/_lib.sh"

newest_call | python3 -c '
import json, sys
call = json.load(sys.stdin)
problems = []
if call["toUri"] != "+15551005":
    problems.append("the newest call is not the declined one")
if call["status"] != "missed":
    problems.append("the declined call ended " + call["status"] + ", not missed")
if not call["calleeUserId"]:
    problems.append("the declined call targeted no user")
if problems:
    sys.exit("; ".join(problems) + ": " + json.dumps(call)[:600])
'
